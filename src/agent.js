// @ts-nocheck
import fs from "node:fs";
import path from "node:path";

import defaultAgent from "./agents/default.js";
import coder from "./agents/coder.js";
import architect from "./agents/architect.js";
import publicWeb from "./agents/publicWeb.js";
import { getNews } from "./tools/news.js";
import { getWeather } from "./tools/weather.js";
import { searchYouTube } from "./tools/youtube.js";
import { analyzeResults } from "./resultAnalyzer.js";
import { searchWeb } from "./tools/search.js";
import { tools, listTools } from "./tools/index.js";// tools — модуль инструментов
import { chooseTool } from "./routerAgent.js";
import * as memory from "./memory.js";
import { askModel } from "./model.js";
import { describeRunningCode } from "./version.js";
import { getDatabaseStatus } from "./database.js";
import { hasSheetIntent } from "./tools/excel/sheets.js";
import { shouldEditExcel } from "./tools/excel/excelTool.js";
import { drawImage, editImage, formatImageResult } from "./tools/drawImage.js";
const MODELS = {
  default: process.env.MODEL_DEFAULT,
  coder: process.env.MODEL_CODER,
  architect: process.env.MODEL_ARCHITECT,
  router: process.env.MODEL_ROUTER
};
/**
 * @interface MemoryModule
 * @property {(text: string) => void} save
 * @property {() => string[]} getAll
 * @property {() => void} clear
 * @property {(index: number) => boolean} remove
 * @property {(text: string) => boolean} removeByText
 */

/**
 * Тип ролей агентов
 * @typedef {Record<string, string>} AgentRoles
 */
/**
 * @interface ToolsModule
 * @property {(expression: string) => number|string} calculate
 * @property {() => string} getTime
 * @property {() => string} generateUuid
 * @property {(text: string) => string} encodeBase64
 * @property {() => number} randomNumber
 */

const MEMORY_COMMANDS = /** @type {Set<string>} */ (
  new Set([
    "что ты помнишь",
    "что ты помниш",
    "память"
  ])
);

/**
 * @param {string} lower
 * @returns {boolean}
 */
function shouldAnalyzeCodebase(lower) {
  return (
    lower === "/codebase" ||
    lower.startsWith("/codebase ") ||
    lower === "/analyze-codebase" ||
    lower.startsWith("/analyze-codebase ") ||
    lower.includes("codebase analyzer") ||
    lower.includes("проанализируй проект") ||
    lower.includes("проанализируй мой проект") ||
    lower.includes("проанализировать проект") ||
    lower.includes("проанализировать мой проект") ||
    lower.includes("анализ проекта") ||
    lower.includes("анализ кодовой базы") ||
    lower.includes("проанализируй кодовую базу") ||
    lower.includes("ревью проекта") ||
    lower.includes("найди ошибки в проекте")
  );
}

/**
 * @param {string} lower
 * @returns {boolean}
 */
export function shouldUseExcelTool(lower) {
  return (
    lower === "/excel" ||
    lower.startsWith("/excel ") ||
    lower === "/purchase-order" ||
    lower.startsWith("/purchase-order ") ||
    lower.includes("замовлення") ||
    lower.includes("заказ т1") ||
    lower.includes("заказ t1") ||
    lower.includes("заказ по отчету") ||
    lower.includes("заказ по отчёту") ||
    lower.includes("отчет о розничных продажах") ||
    lower.includes("подготовь заказ поставщику") ||
    lower.includes("сформируй заказ поставщику") ||
    lower.includes("создай заказ поставщику") ||
    lower.includes("заказ поставщику") ||
    // «заказ только презервативы и лубриканты» — тоже заказ, хотя слова
    // «поставщику» в нём нет. Раньше такая фраза попадала в Excel только через
    // LLM-роутер, то есть через раз.
    (/зака[зж]|замовлення/i.test(lower) &&
      /презерватив|лубрикант|змазк|смазк|весь\s+товар|категори/i.test(lower)) ||
    lower.includes("непродан") ||
    lower.includes("не продал") ||
    lower.includes("неликвид") ||
    lower.includes("нераспродан") ||
    lower.includes("что не продалось") ||
    lower.includes("оставь только") ||
    lower.includes("оставить только") ||
    lower.includes("удали всё кроме") ||
    lower.includes("удали все кроме") ||
    lower.includes("keep only") ||
    /перем[іие]щ/i.test(lower) ||
    /перераспредел|развез|разброса|раскида/i.test(lower) ||
    /перенес|вывез|вывоз/i.test(lower) ||
    /(?:реализац|реалізац|продаж|остат|залиш|запас)[\p{L}]*\s*(?:<=|>=|<|>)\s*\d/u.test(lower) ||
    lower.includes("перекинь") ||
    lower.includes("документ перемещения") ||
    // «Т10 на Т1: SO3206 12» — перемещение текстом: слова «перемещение»
    // в нём нет, а Excel-инструмент нужен.
    /^\s*[\p{L}]\s*\d{1,3}\s*(?:на|->|→)\s*[\p{L}]\s*\d{1,3}\s*:/iu.test(lower) ||
    hasSheetIntent(lower) ||
    shouldEditExcel(lower) ||
    (
      (
        lower.includes("excel") ||
        lower.includes("csv") ||
        lower.includes("таблиц") ||
        lower.includes("остатк") ||
        lower.includes("прайс") ||
        // «найди артикул PJ10050» и «поиск по книге» — тоже про таблицу, а не
        // про интернет. Без этих слов такой запрос уходил в веб-поиск, и бот
        // пересказывал описание товара вместо строки из файла.
        lower.includes("артикул") ||
        lower.includes("книге") ||
        lower.includes("книгу") ||
        lower.includes("выгрузк")
      ) &&
      (
        lower.includes("поставщик") ||
        lower.includes("закуп") ||
        lower.includes("аналит") ||
        lower.includes("отчет") ||
        lower.includes("отчёт") ||
        lower.includes("найди") ||
        lower.includes("поиск")
      )
    )
  );
}

/**
 * Осторожно с «проект»: слово частое и в обычной речи («обсудим мой
 * проект»). Ловим только команды — явные /project(s) и фразы, которые
 * начинаются с «проект»/«покажи проект», а не любое упоминание где-то в
 * середине сообщения.
 * @param {string} lower
 * @returns {boolean}
 */
export function shouldUseProjectManager(lower) {
  if (
    lower === "/project" || lower.startsWith("/project ") ||
    lower === "/projects" || lower.startsWith("/projects")
  ) {
    return true;
  }

  if (
    lower.includes("покажи проекты") ||
    lower.includes("мои проекты") ||
    lower.includes("список проектов") ||
    lower.includes("все проекты")
  ) {
    return true;
  }

  if (/(?:созда[йть]+|нов(?:ый|ая))\s+проект\s+\S/u.test(lower)) {
    return true;
  }

  if (/удали(?:ть)?\s+проект\s+\S/u.test(lower)) {
    return true;
  }

  // «проект <название>» и «покажи проект <название>» — команда должна
  // начинаться с этих слов целиком, а не встречаться где-то в фразе.
  return /^(?:покажи\s+)?проект\s+\S/u.test(lower);
}

/** Однозначные глаголы рисования — объект («картинку») после них не нужен. */
const DRAW_VERBS = ["нарисуй", "нарисуйте", "нарисовать", "draw"];

/**
 * Многозначные глаголы общего действия. «Сделай» и «создай» участвуют и в
 * других командах («сделай заказ поставщику»), поэтому распознаём их как
 * рисование, только если рядом явно стоит «картинку»/«изображение».
 */
const DRAW_VERBS_WITH_OBJECT = [
  "сгенерируй",
  "сгенерировать",
  "создай",
  "создать",
  "сделай",
  "сделать"
];

const DRAW_OBJECTS = ["картинку", "изображение", "фото", "рисунок"];

/**
 * Ищет word как отдельный токен (не часть другого слова) в lowerText.
 * `\bслово\b` тут не подходит: граница \b в JS-регулярках считается только
 * на стыке с [A-Za-z0-9_], а кириллица в \w не входит — обычный \b её не
 * ловит и совпадает где попало. Поэтому границу проверяем вручную.
 * @param {string} lowerText
 * @param {string} word
 * @returns {{start: number, end: number}|null}
 */
function findStandaloneWord(lowerText, word) {
  const isLetterOrDigit = (/** @type {string} */ char) =>
    /[a-zа-яё0-9]/i.test(char);

  let fromIndex = 0;

  while (fromIndex <= lowerText.length) {
    const index = lowerText.indexOf(word, fromIndex);

    if (index === -1) {
      return null;
    }

    const before = index > 0 ? lowerText[index - 1] : "";
    const after = index + word.length < lowerText.length
      ? lowerText[index + word.length]
      : "";

    if (!isLetterOrDigit(before) && !isLetterOrDigit(after)) {
      return { start: index, end: index + word.length };
    }

    fromIndex = index + word.length;
  }

  return null;
}

/**
 * @param {string} lowerText
 * @param {string[]} words
 * @returns {{start: number, end: number}|null}
 */
function findEarliestStandaloneWord(lowerText, words) {
  return words
    .map(word => findStandaloneWord(lowerText, word))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start)[0] || null;
}

/**
 * Срезает ведущее «картинку»/«изображение» и т.п. из остатка фразы — так
 * «нарисуй картинку дракона» и «нарисуй дракона» дают один и тот же промпт.
 * @param {string} remainder
 * @param {string} lowerRemainder
 * @returns {string}
 */
/**
 * Срезает ведущую пунктуацию и пробелы («, пожалуйста, » после глагола),
 * не трогая сам текст описания. `\p{L}`/`\p{N}` с флагом `u` корректно
 * распознают кириллицу как буквы — в отличие от `\w`.
 * @param {string} value
 * @returns {string}
 */
function stripLeadingPunctuation(value) {
  return value.replace(/^[^\p{L}\p{N}]+/u, "");
}

function stripLeadingObjectWord(remainder, lowerRemainder) {
  for (const object of DRAW_OBJECTS) {
    if (lowerRemainder === object) {
      return "";
    }

    if (lowerRemainder.startsWith(`${object} `)) {
      return stripLeadingPunctuation(remainder.slice(object.length));
    }
  }

  return remainder;
}

/**
 * Достаёт описание картинки из свободной фразы. Раньше глагол рисования
 * ловился только в самом начале сообщения точным префиксом — «нарисуй,
 * пожалуйста, дракона» (запятая) или «слушай, нарисуй дракона» (глагол не
 * первый) не совпадали ни с чем и улетали в LLM-роутер. А там всего один
 * пример на инструмент draw («нарисуй кота-программиста»), и слабая модель
 * роутера иногда повторяет этот пример буквально вместо реального запроса —
 * отсюда кот вместо того, что просил пользователь. Прямое правило теперь
 * ищет глагол как отдельное слово где угодно в сообщении, а не только в
 * начале, и не зависит от LLM.
 * @param {string} text
 * @param {string} lower
 * @returns {string|null}
 */
function isDrawingDiscussion(lower) {
  return /^(?:пожалуйста[,\s]+)?(?:не\s+(?:рисуй|нарисуй|рисовать|генерируй|создавай)|объясни|расскажи|что\s+(?:значит|означает)|как\s+(?:работает|использовать))(?=[\s,:.!?]|$)/iu.test(lower);
}

function extractDrawPrompt(text, lower) {
  const slashCommands = [
    "/draw",
    "/image",
    "/picture"
  ];

  for (const command of slashCommands) {
    if (lower === command) {
      return "";
    }

    if (lower.startsWith(`${command} `)) {
      return text.slice(command.length).trim();
    }
  }

  if (isDrawingDiscussion(lower)) {
    return null;
  }

  // Автоматически выполняем только команду с допустимым вступлением.
  // Глагол внутри цитаты или объяснения должен разбирать обычный диалог.
  const isCommandPrefix = start => /^(?:(?:пожалуйста|слушай|можешь|можете|ты|вы|мне)[,\s]*)*$/iu
    .test(lower.slice(0, start));
  const verbMatch = findEarliestStandaloneWord(lower, DRAW_VERBS);

  if (verbMatch && isCommandPrefix(verbMatch.start)) {
    return stripLeadingObjectWord(
      stripLeadingPunctuation(text.slice(verbMatch.end)),
      stripLeadingPunctuation(lower.slice(verbMatch.end))
    );
  }

  const genericVerbMatch = findEarliestStandaloneWord(lower, DRAW_VERBS_WITH_OBJECT);

  if (genericVerbMatch && isCommandPrefix(genericVerbMatch.start)) {
    // Объект должен стоять рядом с глаголом (в пределах короткого окна), а
    // не где угодно в сообщении — иначе «сделай заказ, там ещё рисунок на
    // упаковке» тоже сочли бы рисованием.
    const window = lower.slice(genericVerbMatch.end, genericVerbMatch.end + 30);
    const hasObjectNearby = DRAW_OBJECTS.some(object =>
      findStandaloneWord(window, object)
    );

    if (hasObjectNearby) {
      return stripLeadingObjectWord(
        stripLeadingPunctuation(text.slice(genericVerbMatch.end)),
        stripLeadingPunctuation(lower.slice(genericVerbMatch.end))
      );
    }
  }

  return null;
}

/**
 * Многозначные глаголы редактирования — сами по себе означают что угодно,
 * поэтому засчитываем их только вместе с DRAW_OBJECTS рядом, как и
 * DRAW_VERBS_WITH_OBJECT выше.
 */
const EDIT_VERBS_WITH_OBJECT = [
  "измени",
  "изменить",
  "отредактируй",
  "отредактировать",
  "улучши",
  "улучшить",
  "поправь",
  "поправить"
];

/**
 * Достаёт инструкцию редактирования из свободной фразы — тот же подход, что
 * extractDrawPrompt: глагол как отдельное слово плюс объект «картинку»/
 * «фото» рядом, без обращения к LLM-роутеру.
 * @param {string} text
 * @param {string} lower
 * @returns {string|null}
 */
function extractEditImagePrompt(text, lower) {
  const slashCommands = [
    "/editimage",
    "/edit"
  ];

  for (const command of slashCommands) {
    if (lower === command) {
      return "";
    }

    if (lower.startsWith(`${command} `)) {
      return text.slice(command.length).trim();
    }
  }

  const verbMatch = findEarliestStandaloneWord(lower, EDIT_VERBS_WITH_OBJECT);

  if (!verbMatch) {
    return null;
  }

  const window = lower.slice(verbMatch.end, verbMatch.end + 30);
  const hasObjectNearby = DRAW_OBJECTS.some(object =>
    findStandaloneWord(window, object)
  );

  if (!hasObjectNearby) {
    return null;
  }

  return stripLeadingObjectWord(
    stripLeadingPunctuation(text.slice(verbMatch.end)),
    stripLeadingPunctuation(lower.slice(verbMatch.end))
  );
}

const AGENTS = /** @type {AgentRoles} */ ({
  default: defaultAgent.systemPrompt,
  coder: coder.systemPrompt,
  architect: architect.systemPrompt,
  publicWeb: publicWeb.systemPrompt
});

/**
 * Единая точка входа для публичного веб-виджета (портфолио) — и набор
 * разрешённых инструментов, и персона, и запрет смены роли живут здесь
 * рядом, одним местом для аудита, а не разбросаны по web.js и agent.js.
 * Namespace-инструменты (excel/projects) сюда намеренно НЕ входят: это
 * реальные бизнес-данные владельца, случайным посетителям сайта они не
 * нужны и не предназначены. fileReader/fileWriter/projectTree/codebase —
 * тоже вне списка: они читают/пишут сам код и структуру проекта.
 * @type {ReadonlySet<string>}
 */
const PUBLIC_MODE_ALLOWED_TOOLS = new Set([
  "time",
  "calc",
  "weather",
  "uuid",
  "random",
  "base64",
  "search",
  "youtube",
  "draw"
]);

/** Сообщение для инструмента, запрещённого в публичном режиме. */
const PUBLIC_MODE_TOOL_DENIED =
  "Эта функция доступна только владельцу агента, не в публичном демо-чате.";

/**
 * Список команд одним плоским блоком читался тяжело — 34 строки подряд без
 * разделения. Группировка по смыслу ничего не убирает и не добавляет, только
 * упорядочивает. Обычный текст без Markdown/HTML: этот же блок идёт и в CLI,
 * где теги вроде <b> показались бы буквально.
 */
const HELP_SECTIONS = [
  {
    title: "🤖 Агент",
    lines: [
      "/agents — список агентов",
      "/agent — текущий режим",
      "/agent default|coder|architect — сменить режим",
      "/coder [вопрос] — разовый вопрос JavaScript-наставнику",
      "/architect [вопрос] — разовый вопрос архитектору",
      "/model — модель текущего режима"
    ]
  },
  {
    title: "💬 Память и диалог",
    lines: [
      "запомни [текст] / память — сохранить и показать память",
      "/history — память с номерами записей",
      "/remember — сохранить последнее сообщение",
      "/forget [номер или текст] — удалить запись",
      "/clear — очистить память",
      "/context / /context clear — история текущего диалога"
    ]
  },
  {
    title: "📁 Проекты",
    lines: [
      "/projects — список проектов",
      "создай проект [название] — завести проект",
      "проект [название] — карточка проекта",
      "проект [название] стек: ... — задать стек",
      "проект [название] статус: ... — задать статус",
      "проект [название] задача: ... — добавить задачу",
      "проект [название] готово: ... — отметить задачу",
      "удали проект [название] — удалить проект"
    ]
  },
  {
    title: "🎨 Картинки",
    lines: [
      "/draw [описание] — нарисовать картинку",
      "/editimage [что изменить] — отредактировать последнюю картинку"
    ]
  },
  {
    title: "📊 Excel/CSV",
    lines: [
      "/excel — справка по модулю: поиск, аналитика, заказ, редактирование"
    ]
  },
  {
    title: "🌐 Интернет",
    lines: [
      "/search [запрос] — поиск в интернете",
      "/news [тема] — последние новости",
      "/youtube [запрос] — поиск видео",
      "/weather [город] — погода"
    ]
  },
  {
    title: "🛠 Утилиты",
    lines: [
      "calc [выражение] — калькулятор",
      "время — текущее время",
      "/uuid — сгенерировать UUID",
      "/random — случайное число от 0 до 1",
      "/base64 [текст] — закодировать в Base64",
      "/write путь | текст — записать файл проекта"
    ]
  },
  {
    title: "ℹ️ Информация",
    lines: [
      "/tools — список инструментов",
      "/commands / /help — этот список",
      "/whoami — Chat ID",
      "/stats — статистика чата",
      "/db — статус подключения PostgreSQL",
      "/codebase — анализ кодовой базы проекта"
    ]
  }
];

const HELP_TEXT = HELP_SECTIONS
  .map(section => `${section.title}\n${section.lines.join("\n")}`)
  .join("\n\n");

class Agent {
  /**
   * @type {Message[]}
   */
  conversationHistory;
constructor(chatId = "default", options = {}) {
  this.chatId = String(chatId);
  this.conversationHistory = [];
  // Публичный веб-виджет (портфолио) — options.publicMode из web.js.
  // Telegram и CLI этот параметр не передают вообще, их поведение не
  // меняется ни на символ.
  this.publicMode = Boolean(options.publicMode);
  this.currentAgent = this.publicMode ? "publicWeb" : "default";
  // currentAgent — текущий режим агента
  /** Путь к последней картинке этого чата — цель для «измени картинку». */
  this.lastImagePath = null;
}

/**
 * Разрешён ли инструмент в текущем режиме. В публичном режиме — только
 * PUBLIC_MODE_ALLOWED_TOOLS; вне его — всё разрешено, как и раньше.
 * @param {string} toolName
 * @returns {boolean}
 */
isToolAllowed(toolName) {
  return !this.publicMode || PUBLIC_MODE_ALLOWED_TOOLS.has(toolName);
}
  /**
   * @returns {string}
   */
  showContext() {
  // showContext — показать краткосрочную историю диалога

  if (this.conversationHistory.length === 0) {
    return "История текущего диалога пустая.";
  }

  return this.conversationHistory
    .map((message, index) => {
      const role =
        message.role === "user"
          ? "Ты"
          : "Агент";

      return `${index + 1}. ${role}: ${message.content}`;
    })
    .join("\n\n");
}

/**
 * @param {string|undefined} query
 * @returns {Promise<string>}
 */
async searchWeb(query) {
  // searchWeb — будущий настоящий интернет-поиск

  if (!query) {
    return "Напиши запрос. Например: /search-web новости OpenAI";
  }

  return [
    "Интернет-поиск пока не подключён.",
    "",
    `Запрос: ${query}`,
    "",
    "Следующий шаг: подключить Brave Search API, Tavily или SerpAPI."
  ].join("\n");
}

  /**
   * @param {string|undefined} message
   * @returns {Promise<string>}
   */
  async process(message) {
    const text = String(message || "").trim();
    const lower = text.toLowerCase();
    
    if (!text) {
      return "Напиши команду или вопрос.";
    }

    if (
      lower === "/help" ||
      lower === "/commands" ||
      lower === "команды"
    ) {
      return HELP_TEXT;
    }

    if (lower === "/tools") {
  return this.publicMode
    ? listTools(PUBLIC_MODE_ALLOWED_TOOLS)
    : listTools();
    }

    if (lower === "/model") {
  return (
    MODELS[this.currentAgent] ||
    MODELS.default
  );
}

    if (lower === "/agents") {
      return [
        "Доступные агенты:",
        "/agent default — обычный агент",
        "/coder — JavaScript-наставник",
        "/architect — архитектор AI-агентов"
      ].join("\n");
    }

    if (lower === "/clear") {
      await memory.clear(this.chatId);
      return "Память очищена.";
    }

if (lower === "/context") {
  if (this.conversationHistory.length === 0) {
    return "Контекст пока пуст.";
  }

  return this.conversationHistory
    .map(item =>
      `${item.role}: ${item.content}`
    )
    .join("\n\n");
}

    if (lower === "/tools") {
      return this.showTools();
    }

    if (lower === "/context clear") {
      this.conversationHistory = [];
      return "История текущего диалога очищена.";
    }

if (lower === "/memory") {
  const memories = await memory.getAll(this.chatId);

  if (memories.length === 0) {
    return "Память пуста.";
  }

  return memories.join("\n");
}

if (lower.startsWith("/memory search ")) {
  const query = text.replace("/memory search", "").trim().toLowerCase();

  const memories = await memory.getAll(this.chatId);

  const found = memories.filter(item =>
    item.toLowerCase().includes(query)
  );

  if (found.length === 0) {
    return "В памяти ничего не найдено.";
  }

  return found
    .map((item, index) => `${index + 1}. ${item}`)
    .join("\n");
}

    if (lower === "/history") {
      return this.history();
    }

    if (lower.startsWith("/news ")) {
  const topic = text.slice(6).trim();

      return await getNews(topic);
    }

    if (lower === "/weather" || lower.startsWith("/weather ")) {
      return await this.weather(text.slice(8).trim());
    }

    if (lower === "/remember") {
      return this.rememberLastMessage();
    }

    if (lower.startsWith("/forget ")) {
      return this.forget(text);
    }

    if (lower.startsWith("запомни ")) {
      return this.remember(text.slice(8).trim());
    }

    if (
      lower.startsWith("меня зовут ") ||
      lower.startsWith("моё имя ") ||
      lower.startsWith("мое имя ")
    ) {
      await memory.save(text, this.chatId);
      return `Запомнил: ${text}`;
    }

    if (MEMORY_COMMANDS.has(lower)) {
      return this.recall();
    }

    if (lower.startsWith("calc")) {
  return await this.calculate(
    text.slice(4).trim()
  );
}
    if (lower.includes("врем")) {
      return await tools.time.run();    }

if (lower === "/uuid") {
  return await tools.uuid.run();
}

if (lower === "/random") {
  return await tools.random.run();
}

    if (lower === "/testlong") {
      return "A".repeat(10000);
   }

    if (lower === "/whoami") {
      return `Твой Chat ID: ${this.chatId}`;
    }

    if (lower === "/stats") {
  const memories = await memory.getAll(this.chatId);

  return [
    `Chat ID: ${this.chatId}`,
    `Память: ${memories.length}`,
    `История: ${this.conversationHistory.length}`,
    `Код: ${describeRunningCode()}`
  ].join("\n");
}

if (lower === "/db" || lower === "/database") {
  const status = await getDatabaseStatus();

  return status.message;
}

if (lower === "/agent") {
  return `Текущий агент: ${this.currentAgent}`;
}

const drawPrompt = extractDrawPrompt(text, lower);

if (drawPrompt !== null) {
  return await this.drawNewImage(drawPrompt);
}

const editImagePrompt = extractEditImagePrompt(text, lower);

if (editImagePrompt !== null) {
  return await this.editLastImage(editImagePrompt);
}

if (shouldAnalyzeCodebase(lower) && !this.isToolAllowed("codebase")) {
  return PUBLIC_MODE_TOOL_DENIED;
}

if (shouldAnalyzeCodebase(lower)) {
  const tool = tools.codebase;

  if (!tool) {
    return `Инструмент "codebase" не найден.`;
  }

  const toolResult = await tool.run();

  return await analyzeResults(
    text,
    "codebase",
    String(toolResult)
  );
}

if (shouldUseExcelTool(lower)) {
  if (!this.isToolAllowed("excel")) {
    return PUBLIC_MODE_TOOL_DENIED;
  }

  const memories = await memory.getAll(this.chatId);

  return String(await tools.excel.run({
    query: text,
    memories,
    chatId: this.chatId
  }));
}

if (shouldUseProjectManager(lower)) {
  if (!this.isToolAllowed("projects")) {
    return PUBLIC_MODE_TOOL_DENIED;
  }

  return String(await tools.projects.run({
    query: text,
    chatId: this.chatId
  }));
}

if (lower.startsWith("/agent ")) {
  if (this.publicMode) {
    return "Смена роли недоступна в публичном демо-чате.";
  }

  const mode = text.replace("/agent", "").trim().toLowerCase();

  if (!AGENTS[mode] || mode === "publicWeb") {
    return [
      "Такого агента нет.",
      "Доступные режимы:",
      "/agent default",
      "/agent coder",
      "/agent architect"
    ].join("\n");
  }

  this.currentAgent = mode;

  return `Режим агента переключён: ${mode}`;
}

     if (lower.startsWith("/base64 ")) {
       const textToEncode =
    text.slice(8).trim();

  return await tools.base64.run(
    textToEncode );
    }

        if (lower.startsWith("/youtube ")) {
      return await searchYouTube(text.slice(9).trim());
   }
   if (lower.startsWith("/yt ")) {
     return await searchYouTube(text.slice(4).trim());
   }

if (
  lower.includes("youtube") ||
  lower.includes("ютуб") ||
  lower.includes("видео")
) {
  return await tools.youtube.run(text);
}


if (lower === "/search" || lower.startsWith("/search ")) {
  return await this.search(
    text.slice(8).trim()
  );
}

if (
  lower.includes("найди") ||
  lower.includes("поиск") ||
  lower.includes("что такое")
) {
  return await tools.search.run(text);
}

if (lower.startsWith("weather ")) {
  return await this.weather(text.slice(8).trim());
}

const urlMatch = text.match(/https?:\/\/\S+/i);

if (
  urlMatch &&
  (
    lower.includes("прочитай") ||
    lower.includes("открой") ||
    lower.includes("проанализируй") ||
    lower.includes("сделай конспект") ||
    lower.includes("сайт") ||
    lower.includes("страниц")
  )
) {
  if (!this.isToolAllowed("webReader")) {
    return PUBLIC_MODE_TOOL_DENIED;
  }

  const url = urlMatch[0];

  const tool = tools.webReader;

  if (!tool) {
    return `Инструмент "webReader" не найден.`;
  }

  const toolResult = await tool.run(url);

  return await analyzeResults(
    text,
    "webReader",
    String(toolResult)
  );
}
if (
  lower.startsWith("прочитай файл ") ||
  lower.startsWith("открой файл ") ||
  lower.startsWith("покажи файл ")
) {
  if (!this.isToolAllowed("fileReader")) {
    return PUBLIC_MODE_TOOL_DENIED;
  }

  const filePath = text
    .replace(/^прочитай файл\s+/i, "")
    .replace(/^открой файл\s+/i, "")
    .replace(/^покажи файл\s+/i, "")
    .trim();

  const toolResult = await tools.fileReader.run(filePath);

  return await analyzeResults(
    text,
    "fileReader",
    String(toolResult)
  );
}

if (
  lower.includes("структура проекта") ||
  lower.includes("покажи проект") ||
  lower.includes("дерево проекта") ||
  lower.includes("project tree")
) {
  if (!this.isToolAllowed("projectTree")) {
    return PUBLIC_MODE_TOOL_DENIED;
  }

  const toolResult = await tools.projectTree.run(".");

  return await analyzeResults(
    text,
    "projectTree",
    String(toolResult)
  );
}

if (lower.startsWith("/write ")) {
  if (!this.isToolAllowed("fileWriter")) {
    return PUBLIC_MODE_TOOL_DENIED;
  }

  const payload = text.slice(7).trim();

  const [filePath, ...contentParts] = payload.split("|");
  const content = contentParts.join("|").trim();

  if (!filePath || !content) {
    return "Формат: /write путь/файл.js | содержимое файла";
  }

  const toolResult = await tools.fileWriter.run({
    filePath: filePath.trim(),
    content
  });

  return String(toolResult);
}

const route = await chooseTool(text);
    console.log("ROUTER:", route);

    if (route?.tool === "draw") {
      if (isDrawingDiscussion(lower)) {
        return await this.askAi(text, lower);
      }
      return await this.drawNewImage(route.input || text);
    }

    if (route && route.tool && route.tool !== "none") {
      if (!this.isToolAllowed(route.tool)) {
        return PUBLIC_MODE_TOOL_DENIED;
      }

      const tool = tools[route.tool];

      if (!tool) {
        return `Инструмент "${route.tool}" не найден.`;
      }

let toolInput = route.input;

if (route.tool === "excel") {
  toolInput = {
    query: route.input || text,
    memories: await memory.getAll(this.chatId),
    chatId: this.chatId
  };
} else if (route.tool === "projects") {
  toolInput = {
    query: route.input || text,
    chatId: this.chatId
  };
}
const toolResult = await tool.run(toolInput);
console.log("TOOL:", route.tool);
console.log("INPUT:", toolInput);
console.log("RESULT:", String(toolResult).slice(0, 500));

if (route.tool === "draw" || route.tool === "excel" || route.tool === "projects") {
  return String(toolResult);
}

return await analyzeResults(
  text,
  route.tool,
  String(toolResult)
);    }

    return await this.askAi(text, lower);
  }
  /**
   * @param {string} city
   * @returns {Promise<string>}
   */
  async weather(city) {
    const result = await getWeather(city);
    return String(result ?? "Не удалось получить погоду.");
  }


  /**
   * @param {string} userText
   * @param {string} toolName
   * @param {string} toolInput
   * @param {string} toolResult
   * @returns {Promise<string>}
   */
  async answerWithToolResult(userText, toolName, toolInput, toolResult) {
    const memories = await memory.getAll(this.chatId);
    console.log("MEMORIES:", memories);
    const messages = [
      {
        role: "system",
        content: `Ты AI-агент.

Тебе уже дали готовый результат инструмента.

НЕ говори, что у тебя нет доступа к интернету.
НЕ говори, что ты не можешь узнать погоду.
Используй только данные из результата инструмента.

Ответь простым языком.

Память:
${memories.join("\n")}`
      },
      {
        role: "user",
        content: `Вопрос пользователя:
${userText}

Инструмент:
${toolName}

Вход:
${toolInput}

Результат инструмента:
${toolResult}`
      }
    ];

    const model =
      MODELS[this.currentAgent] ||
      MODELS.default;

    return await askModel(messages, model);
  }

  async askAi(text, lower) {
    
    const memories = await memory.getAll(this.chatId)

let agentRole = AGENTS[this.currentAgent] || AGENTS.default;
let cleanText = text;
let selectedModel =
  MODELS[this.currentAgent] ||
  MODELS.default;

    if (lower.startsWith("/coder") && !this.publicMode) {
      agentRole = AGENTS.coder;
      cleanText = text.replace("/coder", "").trim();
      selectedModel =
        MODELS.coder ||
        selectedModel;
    }
console.log(
  "MODEL ROLE:",
  this.currentAgent
);

console.log(
  "PROMPT:",
  AGENTS[this.currentAgent]
    ?.slice(0, 200)
);
    if (lower.startsWith("/architect") && !this.publicMode) {
      agentRole = AGENTS.architect;
      cleanText = text.replace("/architect", "").trim();
      selectedModel =
        MODELS.architect ||
        selectedModel;
    }

    this.conversationHistory.push({
      role: "user",
      content: cleanText
    });
    // сохраняем сообщение пользователя

    const messages = /** @type {Message[]} */ ([
      {
        role: "system",
        content: `${agentRole}

Память:
${memories.join("\n")}`
      },

      ...this.conversationHistory
    ]);
    // добавляем всю историю
    
    const answer = await askModel(
      messages,
      selectedModel
    );

    this.conversationHistory.push({
      role: "assistant",
      content: answer
    });
    // сохраняем ответ агента

    if (this.conversationHistory.length > 100) {
      this.conversationHistory =
        this.conversationHistory.slice(-100);
    }
    // оставляем последние 100 сообщений
if (lower === "/context") {
  return JSON.stringify(
    this.conversationHistory,
    null,
    2
  );
}
    return answer;
  }

  /**
 * @param {string} query
 * @returns {Promise<string>}
 */
async search(query) {
    // search — исследовательский режим

    if (!query) {
      return "Напиши запрос.";
    }

    const answer = await searchWeb(query);

    this.conversationHistory.push({
      role: "user",
      content: `/search ${query}`
    });

    this.conversationHistory.push({
      role: "assistant",
      content: answer
    });

    return answer;
  }

  /**
   * Веб-поиск с разбором через Ranker/Analyzer — тот же двухшаговый конвейер,
   * что webReader уже использует (сырой результат инструмента → LLM убирает
   * мусор и выбирает главное). У search() выше этого шага нет: он отдаёт
   * сырой форматированный ответ Tavily как есть.
   * @param {string} query
   * @param {(stage: "search"|"analyze") => void|Promise<void>} [onProgress]
   * @returns {Promise<string>}
   */
  async webSearchWithAnalysis(query, onProgress) {
    if (!query) {
      return "Напиши запрос.";
    }

    if (onProgress) {
      await onProgress("search");
    }

    const rawResult = await searchWeb(query);

    if (onProgress) {
      await onProgress("analyze");
    }

    const answer = await analyzeResults(query, "search", rawResult);

    this.conversationHistory.push({
      role: "user",
      content: `/search ${query}`
    });

    this.conversationHistory.push({
      role: "assistant",
      content: answer
    });

    return answer;
  }

  /**
   * Рисует картинку с нуля и запоминает файл как «последнюю картинку» этого
   * чата — на неё будет ссылаться следующая просьба отредактировать.
   * @param {string} prompt
   * @returns {Promise<string>}
   */
  async drawNewImage(prompt) {
    const result = await drawImage(prompt);

    if (result.ok && result.filePath) {
      this.lastImagePath = result.filePath;
    }

    return formatImageResult(result);
  }

  /**
   * Редактирует последнюю нарисованную в этом чате картинку. Источник —
   * файл из exports/, а не Telegram-ссылка: для картинок, на которые
   * человек отвечает реплаем в самом Telegram, есть отдельный путь в
   * telegram.js (там источник — скачанное фото, а не то, что нарисовал бот).
   * @param {string} instruction
   * @returns {Promise<string>}
   */
  async editLastImage(instruction) {
    if (!this.lastImagePath || !fs.existsSync(this.lastImagePath)) {
      return "Сначала нарисуй картинку — редактировать пока нечего.";
    }

    const imageBuffer = fs.readFileSync(this.lastImagePath);
    const mimeType = `image/${path.extname(this.lastImagePath).slice(1) || "png"}`;
    const result = await editImage(instruction, imageBuffer, mimeType);

    if (result.ok && result.filePath) {
      this.lastImagePath = result.filePath;
    }

    return formatImageResult(result);
  }

  /**
   * @param {string} text
   * @returns {string}
   */

  async remember(text) {
    if (!text) {
      return "Напиши, что именно запомнить.";
    }

    await memory.save(text, this.chatId);
    return "Запомнил: " + text;
  }

async rememberName(text) {
  const lower = text.toLowerCase();

  if (
    lower.startsWith("меня зовут ") ||
    lower.startsWith("моё имя ") ||
    lower.startsWith("мое имя ")
  ) {
    await memory.save(text, this.chatId);
    return `Запомнил: ${text}`;
  }

  return null;
}

  /**
   * @returns {string}
   */
  async recall() {
    const all = await memory.getAll(this.chatId);

    if (all.length === 0) {
      return "Пока ничего не помню. Мозг чистый, как новая база данных.";
    }

    return all.join("\n");
  }

  /**
   * @returns {string}
   */
  async history() {
    const all = await memory.getAll(this.chatId);

    if (all.length === 0) {
      return "Память пустая.";
    }

    return all.map((item, index) => `${index + 1}. ${item}`).join("\n");
  }

  /**
   * @param {string} text
   * @returns {string}
   */
  async forget(text) {
    const value = text.replace("/forget", "").trim();

    if (!value) {
      return "Укажи номер или текст. Например: /forget 2";
    }

    if (/^\d+$/.test(value)) {
      const number = Number(value);
      const success = await memory.remove(number - 1, this.chatId);

      if (!success) {
        return "Запись с таким номером не найдена.";
      }

      return `Удалил запись №${number}`;
    }

    const success = await memory.removeByText(value, this.chatId);

    if (!success) {
      return "Такой записи не найдено.";
    }

    return `Удалил: ${value}`;
  }

  /**
   * @returns {string}
   */
  showTools() {
  return [
    "Доступные инструменты:",
    "",
    "/weather [город]",
    "время",
    "calc 2 + 2",
    "/history",
    "/context",
    "/remember",
    "/forget",
    "/uuid",
    "/random",
    "/base64",
    "/db",
    "/codebase",
    "/excel",
    "/draw"
  ].join("\n");
}

  /**
   * @returns {string}
   */
  async rememberLastMessage() {
  // rememberLastMessage — сохранить последнее сообщение пользователя из истории

  const lastUserMessage = [...this.conversationHistory]
    // создаём копию истории

    .reverse()
    // переворачиваем массив, чтобы искать с конца

    .find(message => message.role === "user");
    // ищем последнее сообщение пользователя

  if (!lastUserMessage) {
    return "Пока нечего запоминать.";
  }

await memory.save(
  lastUserMessage.content,
  this.chatId
);  // сохраняем текст в долговременную память

  return `Запомнил: ${lastUserMessage.content}`;
}

  /**
   * @param {string} expression
   * @returns {Promise<string>}
   */
  async calculate(expression) {
    const result = await tools.calc.run(expression);
    return String(result);
  }

}

export default Agent;
