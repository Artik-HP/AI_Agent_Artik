// @ts-nocheck
import defaultAgent from "./agents/default.js";
import coder from "./agents/coder.js";
import architect from "./agents/architect.js";
import { getNews } from "./tools/news.js";
import { getWeather } from "./tools/weather.js";
import { searchYouTube } from "./tools/youtube.js";
import { analyzeResults } from "./resultAnalyzer.js";
import { searchWeb } from "./tools/search.js";
import { tools, listTools } from "./tools/index.js";// tools — модуль инструментов
import { chooseTool } from "./routerAgent.js";
import * as memory from "./memory.js";
import { askModel } from "./model.js";
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

const AGENTS = /** @type {AgentRoles} */ ({
  default: defaultAgent.systemPrompt,
  coder: coder.systemPrompt,
  architect: architect.systemPrompt
});

const HELP_TEXT = [
  "Доступные команды:",
  "/tools — список инструментов",
  "/help — помощь",
  "/agents — список агентов",
  "/coder [вопрос] — JavaScript-наставник",
  "/architect [вопрос] — архитектор AI-агентов",
  "/history — показать память с номерами",
  "/forget [номер или текст] — удалить запись из памяти",
  "/clear — очистить память",
  "/remember — сохранить последнее сообщение пользователя в память",
  "/context — показать историю текущего диалога",
  "/context clear — очистить историю текущего диалога",
  "запомни [текст] — сохранить в память",
  "память — вывести память",
  "calc [выражение] — калькулятор",
  "время — текущее время",
  "/whoami — показать Chat ID",
  "/stats — показать статистику",
  "/agent — показать текущий режим агента",
  "/weather [город] — погода в городе",
  "/youtube [запрос] — поиск видео на YouTube",
  "/uuid — сгенерировать UUID",
  "/random — сгенерировать случайное число от 0 до 1",
  "/base64 [текст] — закодировать текст в Base64",
  "/search [запрос] — поиск в интернете",
  "/news [тема] — последние новости",
  "/codebase — проанализировать кодовую базу проекта"
].join("\n");

class Agent {
  /**
   * @type {Message[]}
   */
  conversationHistory;
constructor(chatId = "default") {
  this.chatId = String(chatId);
  this.conversationHistory = [];
  this.currentAgent = "default";
  // currentAgent — текущий режим агента
}  /**
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

    if (lower === "/help") {
      return HELP_TEXT;
    }

    if (lower === "/tools") {
  return listTools();
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
        "/coder — JavaScript-наставник",
        "/architect — архитектор AI-агентов"
      ].join("\n");
    }

    if (lower === "/clear") {
      memory.clear(this.chatId);
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
  const memories = memory.getAll(this.chatId);

  if (memories.length === 0) {
    return "Память пуста.";
  }

  return memories.join("\n");
}

if (lower.startsWith("/memory search ")) {
  const query = text.replace("/memory search", "").trim().toLowerCase();

  const memories = memory.getAll(this.chatId);

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
      memory.save(text, this.chatId);
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
  return [
    `Chat ID: ${this.chatId}`,
    `Память: ${memory.getAll(this.chatId).length}`,
    `История: ${this.conversationHistory.length}`
  ].join("\n");
}

if (lower === "/agent") {
  return `Текущий агент: ${this.currentAgent}`;
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

if (lower.startsWith("/agent ")) {
  const mode = text.replace("/agent", "").trim().toLowerCase();

  if (!AGENTS[mode]) {
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
    const route = await chooseTool(text);
    console.log("ROUTER:", route);

    if (route && route.tool && route.tool !== "none") {
      const tool = tools[route.tool];

      if (!tool) {
        return `Инструмент "${route.tool}" не найден.`;
      }

const toolResult = await tool.run(route.input);
console.log("TOOL:", route.tool);
console.log("INPUT:", route.input);
console.log("RESULT:", String(toolResult).slice(0, 500));
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
    const memories = memory.getAll(this.chatId);

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
    
    const memories = memory.getAll(this.chatId)

let agentRole = AGENTS[this.currentAgent] || AGENTS.default;
let cleanText = text;
let selectedModel =
  MODELS[this.currentAgent] ||
  MODELS.default;

    if (lower.startsWith("/coder")) {
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
    if (lower.startsWith("/architect")) {
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
   * @param {string} text
   * @returns {string}
   */

  remember(text) {
    if (!text) {
      return "Напиши, что именно запомнить.";
    }

    memory.save(text, this.chatId);
    return "Запомнил: " + text;
  }

rememberName(text) {
  const lower = text.toLowerCase();

  if (
    lower.startsWith("меня зовут ") ||
    lower.startsWith("моё имя ") ||
    lower.startsWith("мое имя ")
  ) {
    memory.save(text, this.chatId);
    return `Запомнил: ${text}`;
  }

  return null;
}

  /**
   * @returns {string}
   */
  recall() {
    const all = memory.getAll(this.chatId);

    if (all.length === 0) {
      return "Пока ничего не помню. Мозг чистый, как новая база данных.";
    }

    return all.join("\n");
  }

  /**
   * @returns {string}
   */
  history() {
    const all = memory.getAll(this.chatId);

    if (all.length === 0) {
      return "Память пустая.";
    }

    return all.map((item, index) => `${index + 1}. ${item}`).join("\n");
  }

  /**
   * @param {string} text
   * @returns {string}
   */
  forget(text) {
    const value = text.replace("/forget", "").trim();

    if (!value) {
      return "Укажи номер или текст. Например: /forget 2";
    }

    if (/^\d+$/.test(value)) {
      const number = Number(value);
      const success = memory.remove(number - 1, this.chatId);

      if (!success) {
        return "Запись с таким номером не найдена.";
      }

      return `Удалил запись №${number}`;
    }

    const success = memory.removeByText(value, this.chatId);

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
    "/codebase"
  ].join("\n");
}

  /**
   * @returns {string}
   */
  rememberLastMessage() {
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

memory.save(
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
