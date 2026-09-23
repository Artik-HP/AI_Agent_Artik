import fs from "node:fs";
import path from "node:path";

import { Markup, Telegraf } from "telegraf";
import Agent from "./agent.js";
import * as memory from "./memory.js";
import {
  detectAudioFormat,
  transcribeAudio
} from "./tools/speech.js";
import { editImage, formatImageResult } from "./tools/drawImage.js";
import { splitMessage }
  from "./utils/splitMessage.js";
import { getDocumentReply, getImageReply } from "./utils/replyFiles.js";
import { sanitizeFileName } from "./utils/fileNames.js";
import { logError, logInfo } from "./utils/logger.js";
import { describeRunningCode } from "./version.js";

const agents = new Map();
const GUIDE_FILE_PATH = process.env.GUIDE_FILE_PATH || (
  process.platform === "win32"
    ? "D:/telegram excel/Справка — команды Telegram Excel.txt"
    : path.resolve("docs", "telegram-excel-guide.txt")
);
const SPREADSHEET_EXTENSIONS = new Set([
  ".csv",
  ".xls",
  ".xlsx"
]);

/** Фраза, которую понимает agent.process как запрос на замовлення Т1. */
const SUPPLIER_ORDER_PHRASE = "Подготовь заказ поставщику.";

/**
 * Та же команда заказа, но суженная до закупаемых категорий. Признак сужения
 * для salesOrder — название категории в тексте, поэтому фраза их называет.
 */
const SUPPLIER_ORDER_CATEGORIES_PHRASE =
  "Подготовь заказ поставщику только по презервативам и лубрикантам.";

/** Фраза, которую agent.process маршрутизирует в отчёт по непроданному. */
const DEAD_STOCK_PHRASE = "Собери непроданное за период.";

/**
 * Шаблон просит назвать склад-источник — без него бот не знает, из какого
 * магазина везём, и вернёт список известных точек.
 */
const TRANSFER_TEMPLATE_PHRASE = "Шаблон перемещения.";

/** Фраза, которую agent.process маршрутизирует в документ перемещения. */
const TRANSFER_PHRASE = "Собери документ перемещения.";

/** Фраза для маршрутизации в перемещение по нулевым продажам. */
const REDISTRIBUTE_PHRASE = "Перемещение по нулевым продажам.";

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

/** Префикс callback_data кнопок Excel-меню. Ограничение Telegram — 64 байта. */
const EXCEL_PREFIX = "xl:";

/**
 * Всё, что бот умеет делать с Excel, одним списком: подпись кнопки и фраза,
 * которую понимает agent.process.
 *
 * Раньше на каждую кнопку была своя константа и свой почти одинаковый
 * обработчик — семь копий одной функции. Из-за этого половина возможностей
 * бота (листы, аналитика, поиск, фильтр) кнопок так и не получила: добавить
 * их стоило дороже, чем сказать пользователю «напиши текстом».
 *
 * `phrase` — действие выполняется сразу. `hint` — действию нужен текст от
 * человека (что искать, что оставить), поэтому кнопка объясняет формат.
 * `menu` — кнопка открывает второй уровень (пороги переноса).
 * @type {{ id: string, label: string, phrase?: string, hint?: string[], menu?: string, notice?: string }[]}
 */
export const EXCEL_ACTIONS = [
  {
    id: "order",
    label: "📦 Заказ поставщику",
    phrase: SUPPLIER_ORDER_PHRASE,
    notice: "Готовлю заказ..."
  },
  {
    id: "order_categories",
    label: "🧴 Заказ: презервативы+лубриканты",
    phrase: SUPPLIER_ORDER_CATEGORIES_PHRASE,
    notice: "Готовлю заказ по категориям..."
  },
  {
    id: "dead_stock",
    label: "🗂 Непроданное",
    phrase: DEAD_STOCK_PHRASE,
    notice: "Собираю непроданное..."
  },
  {
    id: "redistribute",
    label: "♻️ Развезти по продажам",
    phrase: REDISTRIBUTE_PHRASE,
    notice: "Считаю перемещение..."
  },
  {
    id: "criteria",
    label: "🎯 Перенос по условию",
    menu: "criteria"
  },
  {
    id: "transfer",
    label: "🔀 Перемещение из книги",
    phrase: TRANSFER_PHRASE,
    notice: "Разбираю книгу перемещения..."
  },
  {
    id: "transfer_template",
    label: "📄 Шаблон перемещения",
    phrase: TRANSFER_TEMPLATE_PHRASE,
    notice: "Собираю шаблон..."
  },
  {
    id: "sheets",
    label: "📑 Листы книги",
    phrase: "Покажи листы.",
    notice: "Смотрю листы..."
  },
  {
    id: "analytics",
    label: "📊 Аналитика",
    phrase: "Аналитика по excel-файлу.",
    notice: "Считаю сводку..."
  },
  {
    id: "search",
    label: "🔎 Найти товар",
    hint: [
      "Что найти? Напиши: «найди PJ10050 в таблице».",
      "Ищу по всем колонкам последней присланной таблицы."
    ]
  },
  {
    id: "filter",
    label: "✂️ Оставить только…",
    hint: [
      "Что оставить? Напиши: «оставь только pjur».",
      "Вырежу из файла все строки, кроме тех, где это есть в названии.",
      "Исходный файл не меняю — пришлю новый."
    ]
  },
  {
    id: "help",
    label: "📖 Команды и примеры",
    // «/excel» без аргументов — это и есть справка Excel-модуля.
    phrase: "/excel",
    notice: "Показываю команды..."
  },
  {
    id: "text_transfer",
    label: "✍️ Перемещение сообщением",
    hint: [
      "Напиши маршрут и позиции — Excel не нужен:",
      "",
      "Т10 на Т1: SO3206 12, PJ10440 2",
      "Т10 на Х2: BIO_2005 1",
      "",
      "Количество можно не писать. Коды точек — как удобно: т10, T10, Х2."
    ]
  }
];

/**
 * Меню Excel: по две кнопки в ряд — так подписи целиком видны и на телефоне.
 * @returns {ReturnType<typeof Markup.inlineKeyboard>}
 */
function excelKeyboard() {
  /** @type {ReturnType<typeof Markup.button.callback>[][]} */
  const rows = [];

  for (const action of EXCEL_ACTIONS) {
    const button = Markup.button.callback(
      action.label,
      EXCEL_PREFIX + action.id
    );
    const lastRow = rows[rows.length - 1];

    if (lastRow && lastRow.length < 2) {
      lastRow.push(button);
      continue;
    }

    rows.push([button]);
  }

  return Markup.inlineKeyboard(rows);
}

const MAIN_KEYBOARD = Markup.keyboard([
  [
    "Агент: default",
    "Агент: coder",
    "Агент: architect"
  ],
  [
    "🌐 Веб-поиск",
    "Нарисовать картинку"
  ],
  [
    "Команды",
    "🖥 Веб-версия"
  ]
]).resize();

const BUTTON_COMMANDS = new Map([
  ["Агент: default", "/agent default"],
  ["Агент: coder", "/agent coder"],
  ["Агент: architect", "/agent architect"],
  ["🌐 Веб-поиск", "/websearch"],
  ["Нарисовать картинку", "/draw"],
  ["Команды", "/commands"],
  ["🖥 Веб-версия", "/webapp"]
]);

/**
 * Публичный адрес веб-интерфейса для кнопки в Telegram. `WEB_APP_URL` —
 * явная настройка; `RENDER_EXTERNAL_URL` Render подставляет сам для любого
 * web-сервиса, отдельно указывать на Render ничего не нужно. Без ни одной
 * из них показать рабочую ссылку нечем — localhost с телефона не откроется.
 * @returns {string|null}
 */
export function resolveWebAppUrl() {
  const url = process.env.WEB_APP_URL || process.env.RENDER_EXTERNAL_URL;

  return url ? url.trim().replace(/\/+$/, "") : null;
}

/** Префикс callback_data кнопок-примеров веб-поиска. */
const WEBSEARCH_PREFIX = "ws:";

/**
 * Примеры запросов в меню веб-поиска — показывают, что можно спросить,
 * не заставляя придумывать формулировку с нуля.
 * @type {{ id: string, label: string, query: string }[]}
 */
const WEBSEARCH_EXAMPLES = [
  {
    id: "mcp",
    label: "Что такое MCP?",
    query: "Что такое MCP?"
  },
  {
    id: "openai_news",
    label: "Последние новости OpenAI",
    query: "Последние новости OpenAI"
  }
];

/**
 * @returns {ReturnType<typeof Markup.inlineKeyboard>}
 */
function webSearchKeyboard() {
  return Markup.inlineKeyboard(
    WEBSEARCH_EXAMPLES.map(example => [
      Markup.button.callback(example.label, WEBSEARCH_PREFIX + example.id)
    ])
  );
}

/**
 * Подписи стадий прогресса веб-поиска — их видит пользователь, пока
 * progress-сообщение редактируется через ctx.telegram.editMessageText.
 * @type {Record<"search"|"analyze", string>}
 */
const WEBSEARCH_STAGE_LABELS = {
  search: "🔎 Ищу в интернете...",
  analyze: "🧠 Анализирую результаты..."
};

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
  { command: "editimage", description: "Отредактировать последнюю картинку" },
  { command: "search", description: "Поиск в интернете" },
  { command: "websearch", description: "Веб-поиск с примерами и стадиями" },
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
 * @param {string|undefined} fileName
 * @returns {boolean}
 */
function isSpreadsheetDocument(fileName) {
  return SPREADSHEET_EXTENSIONS.has(
    path.extname(String(fileName || "")).toLowerCase()
  );
}

export { sanitizeFileName };

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
      {
        source: imageReply.filePath
      },
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
    const replyToPhoto = ctx.message && "reply_to_message" in ctx.message
      ? ctx.message.reply_to_message?.photo
      : undefined;

    // Ответ на фото инструкцией — редактирование, а не обычный чат.
    // Слэш-команды в реплае (мало ли человек ответил на фото "/help")
    // пропускаем дальше, к обычной обработке команд.
    if (replyToPhoto && replyToPhoto.length > 0 && userText.trim() && !userText.trim().startsWith("/")) {
      await handleImageEditReply(ctx, replyToPhoto, userText.trim());
      return;
    }

    if (userText.trim().toLowerCase() === "/webapp") {
      const webAppUrl = resolveWebAppUrl();

      if (!webAppUrl) {
        await ctx.reply(
          [
            "Веб-интерфейс задеплоен, но я не знаю его публичный адрес.",
            "Задай переменную окружения WEB_APP_URL — и кнопка заработает.",
            "На Render она обычно не нужна: адрес там подставляется сам (RENDER_EXTERNAL_URL)."
          ].join("\n")
        );
        return;
      }

      await ctx.reply(
        "🖥 Тот же агент, что и здесь, но в браузере — чат, кнопки быстрых действий, загрузка и скачивание Excel-файлов.",
        Markup.inlineKeyboard([
          Markup.button.url("Открыть веб-интерфейс", webAppUrl)
        ])
      );
      return;
    }

    if (userText.trim().toLowerCase() === "/websearch") {
      await ctx.reply(
        [
          "🌐 Веб-поиск: ищу в интернете и разбираю ответ через анализатор.",
          "",
          "Выбери пример — покажу стадии поиска прямо в этом чате."
        ].join("\n"),
        webSearchKeyboard()
      );
      return;
    }

    if (userText.trim().toLowerCase() === "/справка") {
      if (!fs.existsSync(GUIDE_FILE_PATH)) {
        await ctx.reply("Файл справки не найден. Проверь: " + GUIDE_FILE_PATH);
        return;
      }

      const guideText = await fs.promises.readFile(GUIDE_FILE_PATH, "utf8");
      for (const chunk of splitMessage(guideText.trim() || "Файл справки пуст.", 3900)) {
        await ctx.reply(chunk);
      }
      return;
    }

    // «печатает…» на весь Bot API живёт секунд пять — на длинных операциях
    // (Excel, рисование) индикатор погаснет раньше ответа. Это лучше, чем
    // ничего: первые секунды ожидания перестают выглядеть как зависание.
    await ctx.sendChatAction("typing").catch(() => {});

    const agent = getAgent(chatId);
    const answer = await agent.process(userText);

    console.log("ANSWER LENGTH:", answer.length);
    await replyAgentAnswer(ctx, answer);
  } catch (error) {
    await handleTelegramError(ctx, error);
  }
}

/**
 * Редактирует картинку, на которую ответил пользователь: берёт самый
 * большой размер фото, скачивает его байты у Telegram и отправляет модели
 * вместе с текстом инструкции. Работает для любой картинки в чате, не
 * только сгенерированной ботом — источник тут просто буфер байт.
 * @param {import("telegraf").Context} ctx
 * @param {Array<{ file_id: string }>} photoSizes
 * @param {string} instruction
 */
async function handleImageEditReply(ctx, photoSizes, instruction) {
  const chatId = ctx.chat?.id;

  try {
    await ctx.sendChatAction("upload_photo").catch(() => {});

    const largestPhoto = photoSizes[photoSizes.length - 1];
    const imageBuffer = await downloadTelegramFile(largestPhoto.file_id, ctx);

    const result = await editImage(instruction, imageBuffer, "image/jpeg");

    if (result.ok && result.filePath) {
      getAgent(chatId).lastImagePath = result.filePath;
    }

    await replyAgentAnswer(ctx, formatImageResult(result));
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
        "Выбери, что с ним сделать — или напиши словами.",
        "Файлы накапливаются: отчёты по разным точкам считаются вместе."
      ].join("\n"),
      excelKeyboard()
    );
  } catch (error) {
    await handleTelegramError(ctx, error);
  }
}

/**
 * Обработчик всех кнопок Excel-меню: находит действие в реестре и выполняет
 * его — фразой агенту, подсказкой или вторым уровнем меню.
 * @param {import("telegraf").Context} ctx
 */
async function handleExcelAction(ctx) {
  const chatId = ctx.chat?.id;
  const id = String(
    (ctx.match && Array.isArray(ctx.match) ? ctx.match[1] : undefined) || ""
  );
  const action = EXCEL_ACTIONS.find(item => item.id === id);

  try {
    if (!action) {
      await ctx.answerCbQuery("Такой кнопки больше нет — открой меню заново.");

      return;
    }

    if (action.menu === "criteria") {
      await handleCriteriaMenuAction(ctx);

      return;
    }

    if (action.hint) {
      await ctx.answerCbQuery();
      await ctx.reply(action.hint.join("\n"), MAIN_KEYBOARD);

      return;
    }

    await ctx.answerCbQuery(action.notice || "Считаю...");

    const agent = getAgent(chatId);
    const answer = await agent.process(action.phrase);

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
        "",
        "Маршрут задаётся полностью:",
        "• откуда: «перенеси с Т1, Т7 и Т9 где реализация<20%»",
        "• куда: «перенеси с Т1 на Т9 и Т10 где остаток>3»",
        "• исключить магазин: «… кроме Т5»",
        "Названия понимаю любые: «с т1», «с Toppers 1», «на ХОХО 2».",
        "",
        "Условия можно совмещать: «перенеси с Т1 где остаток>10 реализация<40%».",
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
 * Выполняет веб-поиск с индикатором стадий: одно сообщение бот редактирует
 * через «Поиск в интернете» → «Анализ» → финальный ответ, вместо трёх
 * отдельных сообщений, которые засоряют чат.
 * @param {import("telegraf").Context} ctx
 * @param {string | number | undefined} chatId
 * @param {string} query
 */
async function runWebSearchWithProgress(ctx, chatId, query) {
  const progressMessage = await ctx.reply(`🔎 Ищу: «${query}»...`);

  const editProgress = async text => {
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        progressMessage.message_id,
        undefined,
        text
      );
    } catch (error) {
      // "message is not modified" — стадия наступила раньше, чем успело
      // прийти обновление, текст уже совпадает. Не повод ронять поиск.
      const message = error instanceof Error ? error.message : String(error);

      if (!message.includes("message is not modified")) {
        throw error;
      }
    }
  };

  try {
    const agent = getAgent(chatId);
    const answer = await agent.webSearchWithAnalysis(
      query,
      stage => editProgress(WEBSEARCH_STAGE_LABELS[stage])
    );

    const parts = splitMessage(answer, 3900);

    await editProgress(parts[0]);

    for (const part of parts.slice(1)) {
      await ctx.reply(part);
    }
  } catch (error) {
    await handleTelegramError(ctx, error);
  }
}

/**
 * Кнопка примера из меню веб-поиска: запускает поиск с индикатором стадий.
 * @param {import("telegraf").Context} ctx
 */
async function handleWebSearchExampleAction(ctx) {
  const chatId = ctx.chat?.id;
  const id = String(
    (ctx.match && Array.isArray(ctx.match) ? ctx.match[1] : undefined) || ""
  );
  const example = WEBSEARCH_EXAMPLES.find(item => item.id === id);

  try {
    if (!example) {
      await ctx.answerCbQuery("Такой кнопки больше нет — открой меню заново.");
      return;
    }

    await ctx.answerCbQuery(`Ищу: ${example.label}`);
    await runWebSearchWithProgress(ctx, chatId, example.query);
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
      [
        "<b>Привет! Я AI Agent Artik 🤖</b>",
        "",
        "Персональный AI-агент: обычный чат с памятью, Excel/CSV-аналитика, " +
          "веб-поиск с разбором ответа и рисование/редактирование картинок — " +
          "всё в одном Telegram-боте.",
        "",
        "<b>Быстрый старт:</b>",
        "🎨 «нарисуй дракона в горах» — сгенерирую картинку; ответь на неё " +
          "текстом, чтобы поправить результат",
        "🌐 кнопка «Веб-поиск» ниже — поиск в интернете с разбором ответа",
        "📊 пришли Excel/CSV-файл — открою меню отчётов и заказа поставщику",
        "🖥 кнопка «Веб-версия» ниже — тот же агент в браузере",
        "💬 всё остальное — обычный вопрос, отвечу как ассистент",
        "",
        "/commands — полный список команд"
      ].join("\n"),
      {
        parse_mode: "HTML",
        ...MAIN_KEYBOARD
      }
    );
  });

  bot.action(new RegExp(`^${CRITERIA_PREFIX}(.+)$`), handleCriteriaPresetAction);
  bot.action(new RegExp(`^${EXCEL_PREFIX}(.+)$`), handleExcelAction);
  bot.action(new RegExp(`^${WEBSEARCH_PREFIX}(.+)$`), handleWebSearchExampleAction);
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
