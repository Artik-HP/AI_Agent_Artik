import fs from "node:fs";
import path from "node:path";

import { Markup, Telegraf } from "telegraf";
import Agent from "./agent.js";
import * as memory from "./memory.js";
import {
  detectAudioFormat,
  transcribeAudio
} from "./tools/speech.js";
import { splitMessage }
  from "./utils/splitMessage.js";
import { logError, logInfo } from "./utils/logger.js";
import { describeRunningCode } from "./version.js";

const agents = new Map();
const SPREADSHEET_EXTENSIONS = new Set([
  ".csv",
  ".xls",
  ".xlsx"
]);

/** callback_data кнопки «Заказ поставщику» под сообщением о загрузке файла. */
const SUPPLIER_ORDER_ACTION = "supplier_order";
/** Фраза, которую понимает agent.process как запрос на замовлення Т1. */
const SUPPLIER_ORDER_PHRASE = "Подготовь заказ поставщику.";

/** callback_data кнопки «Заказ: презервативы + лубриканты». */
const SUPPLIER_ORDER_CATEGORIES_ACTION = "supplier_order_categories";
/**
 * Та же команда заказа, но суженная до закупаемых категорий. Признак сужения
 * для salesOrder — название категории в тексте, поэтому фраза их называет.
 */
const SUPPLIER_ORDER_CATEGORIES_PHRASE =
  "Подготовь заказ поставщику только по презервативам и лубрикантам.";

/** callback_data кнопки «Непроданное» под сообщением о загрузке файла. */
const DEAD_STOCK_ACTION = "dead_stock";
/** Фраза, которую agent.process маршрутизирует в отчёт по непроданному. */
const DEAD_STOCK_PHRASE = "Собери непроданное за период.";

/** callback_data кнопки «Перемещение» под сообщением о загрузке файла. */
const TRANSFER_ACTION = "transfer_doc";
/** Фраза, которую agent.process маршрутизирует в документ перемещения. */
const TRANSFER_PHRASE = "Собери документ перемещения.";

/** callback_data кнопки «Развезти по продажам» (перераспределение остатков). */
const REDISTRIBUTE_ACTION = "redistribute";
/** Фраза для маршрутизации в перемещение по нулевым продажам. */
const REDISTRIBUTE_PHRASE = "Перемещение по нулевым продажам.";

/** callback_data кнопки, открывающей меню условий переноса. */
const CRITERIA_MENU_ACTION = "criteria_menu";
/** Префикс callback_data пресетов условия. Ограничение Telegram — 64 байта. */
const CRITERIA_PREFIX = "crit:";

/**
 * Готовые условия переноса. Кнопка не может нести произвольный порог, поэтому
 * держим набор частых, а редкие пользователь пишет текстом.
 * @type {{ id: string, label: string, phrase: string }[]}
 */
export const CRITERIA_PRESETS = [
  {
    id: "st20",
    label: "Реализация < 20%",
    phrase: "Перенеси где реализация<20%"
  },
  {
    id: "st40",
    label: "Реализация < 40%",
    phrase: "Перенеси где реализация<40%"
  },
  {
    id: "sales3",
    label: "Продаж < 3 шт",
    phrase: "Перенеси где продаж<3"
  },
  {
    id: "days60",
    label: "Запас > 60 дней",
    phrase: "Перенеси где запас>60"
  },
  {
    id: "stock10",
    label: "Остаток > 10 и реализация < 40%",
    phrase: "Перенеси где остаток>10 реализация<40%"
  }
];

const MAIN_KEYBOARD = Markup.keyboard([
  [
    "Агент: default",
    "Агент: coder",
    "Агент: architect"
  ],
  [
    "Нарисовать картинку",
    "Команды"
  ]
]).resize();

const BUTTON_COMMANDS = new Map([
  ["Агент: default", "/agent default"],
  ["Агент: coder", "/agent coder"],
  ["Агент: architect", "/agent architect"],
  ["Нарисовать картинку", "/draw"],
  ["Команды", "/commands"]
]);

/**
 * Меню команд Telegram — выпадающий список по кнопке «/» в поле ввода.
 * Ограничения Bot API: имя без слэша, только a-z, 0-9 и «_», до 32 символов;
 * описание до 256 символов; не больше 100 команд. Аргументы команд
 * («/agent default», «/context clear») Telegram в меню не показывает,
 * поэтому здесь только базовые имена.
 * @type {{ command: string, description: string }[]}
 */
const BOT_COMMANDS = [
  { command: "start", description: "Запустить бота" },
  { command: "help", description: "Список всех команд" },
  { command: "commands", description: "Список всех команд" },
  { command: "tools", description: "Список инструментов" },
  { command: "agents", description: "Список агентов" },
  { command: "agent", description: "Текущий режим агента или смена: /agent coder" },
  { command: "coder", description: "JavaScript-наставник" },
  { command: "architect", description: "Архитектор AI-агентов" },
  { command: "excel", description: "Excel/CSV: поиск, аналитика, заказ поставщику" },
  { command: "draw", description: "Нарисовать картинку по описанию" },
  { command: "search", description: "Поиск в интернете" },
  { command: "news", description: "Последние новости по теме" },
  { command: "weather", description: "Погода в городе" },
  { command: "youtube", description: "Поиск видео на YouTube" },
  { command: "codebase", description: "Проанализировать кодовую базу проекта" },
  { command: "write", description: "Записать текст в файл: /write путь | текст" },
  { command: "memory", description: "Показать долгую память" },
  { command: "history", description: "Память с номерами записей" },
  { command: "remember", description: "Сохранить последнее сообщение в память" },
  { command: "forget", description: "Удалить запись из памяти по номеру или тексту" },
  { command: "clear", description: "Очистить память" },
  { command: "context", description: "История текущего диалога" }
];

/**
 * @param {string | number | undefined} chatId
 */
function getAgent(chatId) {
  if (!agents.has(chatId)) {
    const agentId = chatId !== undefined ? String(chatId) : undefined;
    agents.set(chatId, new Agent(agentId));
  }

  return agents.get(chatId);
}

/**
 * @param {import("telegraf").Context} ctx
 * @param {string} answer
 */
async function replyInParts(ctx, answer) {
  const parts = splitMessage(answer, 3900);

  console.log(
    "PARTS:",
    parts.length
  );

  for (const [index, part] of parts.entries()) {
    if (index === 0) {
      await ctx.reply(part, MAIN_KEYBOARD);
      continue;
    }

    await ctx.reply(part);
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeTelegramText(text) {
  return BUTTON_COMMANDS.get(text) || text;
}

/**
 * @param {string} answer
 * @returns {{url: string, caption: string}|null}
 */
function getImageReply(answer) {
  const match = answer.match(
    /^Картинка готова:\n(https:\/\/image\.pollinations\.ai\/\S+)/m
  );

  if (!match) {
    return null;
  }

  const promptMatch = answer.match(/\nПромпт: ([\s\S]+)$/);
  const prompt = String(promptMatch?.[1] || "").trim();
  const caption = prompt
    ? `Картинка готова.\nПромпт: ${prompt.slice(0, 900)}`
    : "Картинка готова.";

  return {
    url: match[1],
    caption
  };
}

/**
 * @param {string} answer
 * @returns {{filePath: string, fileName: string, caption: string}|null}
 */
function getDocumentReply(answer) {
  const match = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  if (!match) {
    return null;
  }

  const filePath = path.resolve(String(match[1]).trim());

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return {
    filePath,
    fileName: path.basename(filePath),
    caption: answer
      .replace(/^Excel-файл:\s*.+\.xlsx\s*$/m, "Excel-файл прикреплён.")
      .slice(0, 1000)
  };
}

/**
 * @param {string|undefined} fileName
 * @returns {boolean}
 */
function isSpreadsheetDocument(fileName) {
  return SPREADSHEET_EXTENSIONS.has(
    path.extname(String(fileName || "")).toLowerCase()
  );
}

/**
 * Приводит имя файла к безопасному виду. Кроме символов, запрещённых в путях
 * (`<>:"/\|?*`), убираем `,` и `;` — дальше по коду extractSpreadsheetPaths
 * трактует их как разделители списка файлов, и запятая в имени превращается
 * в ложный путь вида «_хвост_после_запятой.xlsx».
 * @param {string} value
 * @returns {string}
 */
export function sanitizeFileName(value) {
  return String(value || "table.xlsx")
    .replace(/[<>:"/\\|?*,;]/g, "_")
    .split("")
    .filter(char => char.charCodeAt(0) >= 32)
    .join("")
    .slice(0, 120);
}

/**
 * Обрыв связи, который лечится повтором, а не разбором причины.
 * @param {unknown} error
 * @returns {boolean}
 */
function isTransientNetworkError(error) {
  const code = error && typeof error === "object"
    ? String(/** @type {{ code?: unknown }} */ (error).code || "")
    : "";
  const message = error instanceof Error ? error.message : String(error);

  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i
    .test(`${code} ${message}`);
}

/**
 * @param {import("telegraf").Context} ctx
 * @param {string} answer
 */
async function replyAgentAnswer(ctx, answer) {
  const documentReply = getDocumentReply(answer);

  if (documentReply) {
    // Один повтор на обрыв связи. Telegram рвёт соединение на середине
    // загрузки книги (ECONNRESET, socket hang up) — это дрожание канала, а не
    // испорченный файл, и вторая попытка обычно проходит. Без повтора человек
    // вместо книги получал текст с путём к файлу внутри сервера.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await ctx.replyWithDocument(
          {
            source: documentReply.filePath,
            filename: documentReply.fileName
          },
          {
            caption: documentReply.caption,
            ...MAIN_KEYBOARD
          }
        );
        return;
      } catch (error) {
        logError(`Не отправился документ (попытка ${attempt}):`, error);

        if (attempt === 2 || !isTransientNetworkError(error)) {
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
  }

  const imageReply = getImageReply(answer);

  if (!imageReply) {
    await replyInParts(ctx, answer);
    return;
  }

  try {
    await ctx.replyWithPhoto(
      imageReply.url,
      {
        caption: imageReply.caption,
        ...MAIN_KEYBOARD
      }
    );
  } catch (error) {
    console.error("Telegram image reply error:", error);
    await replyInParts(ctx, answer);
  }
}

/**
 * @param {string} fileId
 * @param {import("telegraf").Context} ctx
 * @returns {Promise<Buffer>}
 */
async function downloadTelegramFile(fileId, ctx) {
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(fileLink);

  if (!response.ok) {
    throw new Error(
      `Не удалось скачать файл из Telegram: ${response.status}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * @param {import("telegraf").Context} ctx
 */
async function handleTextMessage(ctx) {
  console.log("TEXT FROM TELEGRAM:", ctx.message && 'text' in ctx.message ? ctx.message.text : undefined);
  console.log("CHAT ID:", ctx.chat?.id);
  const chatId = ctx.chat?.id;
  const userText = normalizeTelegramText((ctx.message && 'text' in ctx.message ? ctx.message.text : undefined) ?? "");

  try {
    const agent = getAgent(chatId);
    const answer = await agent.process(userText);

    console.log("ANSWER LENGTH:", answer.length);
    await replyAgentAnswer(ctx, answer);
  } catch (error) {
    await handleTelegramError(ctx, error);
  }
}

/**
 * @param {import("telegraf").Context} ctx
 */
async function handleSpeechMessage(ctx) {
  const message = ctx.message;
  const audio = (message && 'voice' in message ? message.voice : undefined) || (message && 'audio' in message ? message.audio : undefined);
  const chatId = ctx.chat?.id;

  if (!audio) {
    return;
  }

  try {
    await ctx.reply("Распознаю голос...");

    const audioBuffer = await downloadTelegramFile(audio.file_id, ctx);
    const text = await transcribeAudio(audioBuffer, {
      format: detectAudioFormat(audio.mime_type, 'file_name' in audio && typeof audio.file_name === 'string' ? audio.file_name : undefined),
      language: process.env.OPENROUTER_STT_LANGUAGE || process.env.STT_LANGUAGE
    });

    console.log("VOICE TRANSCRIPT:", text);

    const agent = getAgent(chatId);
    const answer = await agent.process(text);

    await ctx.reply(`Распознал: ${text}`);
    await replyAgentAnswer(ctx, answer);
  } catch (error) {
    await handleTelegramError(ctx, error);
  }
}

/**
 * @param {import("telegraf").Context} ctx
 */
async function handleDocumentMessage(ctx) {
  const message = ctx.message;
  const document = message && "document" in message
    ? message.document
    : null;
  const chatId = ctx.chat?.id;

  if (!document) {
    return;
  }

  const originalFileName = document.file_name || "table.xlsx";

  if (!isSpreadsheetDocument(originalFileName)) {
    await ctx.reply(
      "Сейчас я принимаю Excel/CSV-файлы: .xlsx, .xls или .csv."
    );
    return;
  }

  try {
    const fileBuffer = await downloadTelegramFile(document.file_id, ctx);
    const uploadDir = path.resolve(
      process.cwd(),
      "data",
      "telegram",
      String(chatId || "default")
    );
    const fileName = `${Date.now()}-${sanitizeFileName(originalFileName)}`;
    const filePath = path.join(uploadDir, fileName);

    fs.mkdirSync(uploadDir, {
      recursive: true
    });
    fs.writeFileSync(filePath, new Uint8Array(fileBuffer));

    const projectPath = path
      .relative(process.cwd(), filePath)
      .split(path.sep)
      .join("/");

    await memory.save(
      `Excel файл загружен: ${projectPath}`,
      chatId
    );

    await ctx.reply(
      [
        `✅ Файл получил: ${projectPath}`,
        "",
        "Что дальше — просто напиши:",
        "• «Заказ поставщику» — соберу замовлення Т1 в Excel",
        "• «Непроданное» — товары без розничных и оптовых продаж за период",
        "• «Развезти по продажам» — вывезти оттуда, где не продаётся, туда, где продаётся",
        "• «Перенеси где реализация<20%» — перенос по условию (реализация, продаж, остаток, запас)",
        "• «Перемещение» — список артикулов по листам-магазинам → один документ",
        "• «Оставь только <текст>» — вырежу все строки, кроме нужных по названию",
        "• «Аналитика» — краткая сводка по файлу",
        "• «Найди <текст>» — поиск строк в таблице"
      ].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("📦 Заказ поставщику", SUPPLIER_ORDER_ACTION)],
        [Markup.button.callback(
          "🧴 Заказ: презервативы + лубриканты",
          SUPPLIER_ORDER_CATEGORIES_ACTION
        )],
        [Markup.button.callback("🗂 Непроданное", DEAD_STOCK_ACTION)],
        [Markup.button.callback("♻️ Развезти по продажам", REDISTRIBUTE_ACTION)],
        [Markup.button.callback("🎯 Перенос по условию", CRITERIA_MENU_ACTION)],
        [Markup.button.callback("🔀 Перемещение", TRANSFER_ACTION)]
      ])
    );
  } catch (error) {
    await handleTelegramError(ctx, error);
  }
}

/**
 * Кнопка «Заказ поставщику» под сообщением о загрузке файла.
 * @param {import("telegraf").Context} ctx
 */
async function handleSupplierOrderAction(ctx) {
  const chatId = ctx.chat?.id;

  try {
    await ctx.answerCbQuery("Готовлю заказ...");

    const agent = getAgent(chatId);
    const answer = await agent.process(SUPPLIER_ORDER_PHRASE);

    await replyAgentAnswer(ctx, answer);
  } catch (error) {
    await handleTelegramError(ctx, error);
  }
}

/**
 * Кнопка «Заказ: презервативы + лубриканты» — тот же заказ, суженный до
 * закупаемых категорий.
 * @param {import("telegraf").Context} ctx
 */
async function handleSupplierOrderCategoriesAction(ctx) {
  const chatId = ctx.chat?.id;

  try {
    await ctx.answerCbQuery("Готовлю заказ по категориям...");

    const agent = getAgent(chatId);
    const answer = await agent.process(SUPPLIER_ORDER_CATEGORIES_PHRASE);

    await replyAgentAnswer(ctx, answer);
  } catch (error) {
    await handleTelegramError(ctx, error);
  }
}

/**
 * Кнопка «Непроданное» под сообщением о загрузке файла.
 * @param {import("telegraf").Context} ctx
 */
async function handleDeadStockAction(ctx) {
  const chatId = ctx.chat?.id;

  try {
    await ctx.answerCbQuery("Собираю непроданное...");

    const agent = getAgent(chatId);
    const answer = await agent.process(DEAD_STOCK_PHRASE);

    await replyAgentAnswer(ctx, answer);
  } catch (error) {
    await handleTelegramError(ctx, error);
  }
}

/**
 * Кнопка «Развезти по продажам»: перемещение с нулевых точек на продающие.
 * @param {import("telegraf").Context} ctx
 */
async function handleRedistributeAction(ctx) {
  const chatId = ctx.chat?.id;

  try {
    await ctx.answerCbQuery("Считаю перемещение...");

    const agent = getAgent(chatId);
    const answer = await agent.process(REDISTRIBUTE_PHRASE);

    await replyAgentAnswer(ctx, answer);
  } catch (error) {
    await handleTelegramError(ctx, error);
  }
}

/**
 * Кнопка «Перенос по условию»: показывает второй ряд кнопок с готовыми
 * порогами. Одной кнопкой произвольный порог не передать, поэтому меню
 * двухуровневое, а редкие условия пользователь пишет текстом.
 * @param {import("telegraf").Context} ctx
 */
async function handleCriteriaMenuAction(ctx) {
  try {
    await ctx.answerCbQuery("Выбери условие");

    await ctx.reply(
      [
        "По какому условию вывозить товар?",
        "",
        "Считаю по всем точкам сразу. Товар едет туда, где он продаётся и",
        "скоро кончится; везу столько, сколько получателю нужно, остальное",
        "остаётся на месте.",
        "",
        "Свой порог — текстом: «перенеси где реализация<15%».",
        "Один магазин-источник: «перенеси с Т5 где реализация<15%»",
        "(понимаю и «с toppers 1», и «с т1»).",
        "Конкретный получатель: «перенеси с т1 на т9 где остаток>3».",
        "Если период не виден в имени файла — допиши «период=30»."
      ].join("\n"),
      Markup.inlineKeyboard(
        CRITERIA_PRESETS.map(preset => [
          Markup.button.callback(preset.label, CRITERIA_PREFIX + preset.id)
        ])
      )
    );
  } catch (error) {
    await handleTelegramError(ctx, error);
  }
}

/**
 * Кнопка конкретного условия из меню переноса.
 * @param {import("telegraf").Context} ctx
 */
async function handleCriteriaPresetAction(ctx) {
  const chatId = ctx.chat?.id;

  try {
    const match = /** @type {RegExpExecArray|undefined} */ (
      /** @type {unknown} */ (ctx.match)
    );
    const preset = CRITERIA_PRESETS.find(item => item.id === String(match?.[1] || ""));

    if (!preset) {
      await ctx.answerCbQuery("Не знаю такое условие");
      return;
    }

    await ctx.answerCbQuery(`Считаю: ${preset.label}`);

    const agent = getAgent(chatId);
    const answer = await agent.process(preset.phrase);

    await replyAgentAnswer(ctx, answer);
  } catch (error) {
    await handleTelegramError(ctx, error);
  }
}

/**
 * Кнопка «Перемещение» под сообщением о загрузке файла.
 * @param {import("telegraf").Context} ctx
 */
async function handleTransferAction(ctx) {
  const chatId = ctx.chat?.id;

  try {
    await ctx.answerCbQuery("Собираю перемещение...");

    const agent = getAgent(chatId);
    const answer = await agent.process(TRANSFER_PHRASE);

    await replyAgentAnswer(ctx, answer);
  } catch (error) {
    await handleTelegramError(ctx, error);
  }
}

/**
 * @param {import("telegraf").Context} ctx
 * @param {unknown} error
 */
async function handleTelegramError(ctx, error) {
  logError("Ошибка обработчика Telegram:", error);

  const message = error instanceof Error ? error.message : String(error);

  // Раньше здесь был голый ctx.reply. Текст ошибки бывает длиннее лимита
  // Telegram (4096 символов) — например, со стеком ExcelJS или списком путей;
  // reply падал внутри catch, reject уходил наверх необработанным и убивал
  // процесс. Бот исчезал молча ровно в тот момент, когда что-то сломалось.
  try {
    await ctx.reply(splitMessage(`Ошибка: ${message}`, 3900)[0]);
  } catch (replyError) {
    logError("Не смог отправить сообщение об ошибке:", replyError);
  }
}

/**
 * Регистрирует меню команд на серверах Telegram.
 * Сбой не должен ронять бота: без меню он полностью работоспособен,
 * команды по-прежнему можно набирать вручную. Один невалидный элемент
 * списка отклоняет весь запрос, поэтому ошибку пишем в лог явно.
 * @param {import("telegraf").Telegraf} bot
 * @returns {Promise<void>}
 */
async function registerBotCommands(bot) {
  try {
    await bot.telegram.setMyCommands(BOT_COMMANDS);

    console.log(
      "Меню команд зарегистрировано:",
      BOT_COMMANDS.length
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    console.error(
      "Не удалось зарегистрировать меню команд:",
      message
    );
  }
}

export async function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN не найден"
    );
  }

  const bot = new Telegraf(token);

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  bot.start(ctx => {
    return ctx.reply(
      "Привет! Я AI_Agent_JS 🤖\nВыбери агента, открой команды или попроси нарисовать картинку.",
      MAIN_KEYBOARD
    );
  });

  bot.action(SUPPLIER_ORDER_ACTION, handleSupplierOrderAction);
  bot.action(
    SUPPLIER_ORDER_CATEGORIES_ACTION,
    handleSupplierOrderCategoriesAction
  );
  bot.action(DEAD_STOCK_ACTION, handleDeadStockAction);
  bot.action(REDISTRIBUTE_ACTION, handleRedistributeAction);
  bot.action(CRITERIA_MENU_ACTION, handleCriteriaMenuAction);
  bot.action(new RegExp(`^${CRITERIA_PREFIX}(.+)$`), handleCriteriaPresetAction);
  bot.action(TRANSFER_ACTION, handleTransferAction);
  bot.on("text", handleTextMessage);
  bot.on("voice", handleSpeechMessage);
  bot.on("audio", handleSpeechMessage);
  bot.on("document", handleDocumentMessage);

  // Последний рубеж: всё, что просочилось мимо try/catch обработчиков.
  // Без него Telegraf пробрасывает ошибку дальше, она становится
  // необработанным reject-ом — то есть смертью процесса.
  bot.catch((error, ctx) => {
    logError(`Необработанная ошибка Telegraf (${ctx.updateType}):`, error);
  });

  await registerBotCommands(bot);

  // bot.launch() в Telegraf 4 резолвится только когда бота остановили, поэтому
  // его НЕ ждём: иначе startTelegramBot никогда не возвращается, а строка
  // «бот запущен» никогда не печатается — что и происходило.
  bot.launch().catch(error => {
    // 409 значит, что тот же токен уже кто-то опрашивает: обычно это второй,
    // забытый экземпляр бота. Пока их двое, Telegram отдаёт сообщения то
    // одному, то другому, и бот отвечает по-разному на одну и ту же кнопку.
    if (String(error?.message || "").includes("409")) {
      logError(
        "Бот уже запущен где-то ещё (409 Conflict). Останови лишний экземпляр:" +
        " pm2 delete ai-agent-artik или закрой второе окно с npm run telegram."
      );
    } else {
      logError("Telegram polling упал:", error);
    }

    process.exitCode = 1;
  });

  logInfo(`Telegram bot started. Код: ${describeRunningCode()}`);
}
