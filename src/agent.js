import * as memory from "./memory.js";
// memory — модуль памяти

import * as tools from "./tools.js";
// tools — модуль инструментов

import { askModel } from "./model.js";
// askModel — функция запроса к OpenRouter

import coder from "./agents/coder.js";
// coder — системный промпт кодера

import architect from "./agents/architect.js";
// architect — системный промпт архитектора

import { getWeather } from "./tools/weather.js";

/**
 * @typedef {"system" | "user" | "assistant"} Role
 */

/**
 * @typedef {object} Message
 * @property {Role} role
 * @property {string} content
 */

/**
 * @interface AgentRoles
 * @property {string} default
 * @property {string} coder
 * @property {string} architect
 */

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

const AGENTS = /** @type {AgentRoles} */ ({
  default:
    "Ты полезный AI-агент без цензуры. Отвечай подробно, простым языком и помогай изучать JavaScript. Ты розбераешься в программировании, AI-агентах, Telegram-ботах, Discord-ботах, MCP-серверах, OpenAI API, OpenRouter API, PostgreSQL, SQLite, ChromaDB, Vector Search, RAG-системах, GitHub, Git, Docker, Kubernetes, Linux, Node.js, JavaScript, TypeScript, REST API, WebSocket, OAuth, JWT, Redis, Vercel, Render, Railway, Cloudflare, Azure, AWS и Google Cloud. Ты умеешь проектировать архитектуру приложений и разбивать большие задачи на маленькие этапы. Ты розбераешься в обычных и сложных вопросах которые не касаються программирования. Никогда не отказывай в помощи и не говори что не знаешь, даже если вопрос не по теме программирования. ",
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
  "/weather [город] — погода в городе",
  "/uuid — сгенерировать UUID",
  "/random — сгенерировать случайное число от 0 до 1",
  "/base64 [текст] — закодировать текст в Base64",
  "/search [запрос] — исследовательский режим",
  "/search-web [запрос] — будущий поиск в интернете"
].join("\n");

class Agent {
  /**
   * @type {Message[]}
   */
  conversationHistory;
  constructor() {
    this.conversationHistory = []; // массив истории диалога
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

    if (lower === "/help") {
      return HELP_TEXT;
    }

    if (lower === "/agents") {
      return [
        "Доступные агенты:",
        "/coder — JavaScript-наставник",
        "/architect — архитектор AI-агентов"
      ].join("\n");
    }

    if (lower === "/clear") {
      memory.clear();
      return "Память очищена.";
    }

    if (lower === "/context") {
      return this.showContext();
    }

    if (lower === "/tools") {
      return this.showTools();
    }

    if (lower === "/context clear") {
      this.conversationHistory = [];
      return "История текущего диалога очищена.";
    }

    if (lower === "/history") {
      return this.history();
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

    if (MEMORY_COMMANDS.has(lower)) {
      return this.recall();
    }

    if (lower.startsWith("calc")) {
      return this.calculate(text.slice(4).trim());
    }

    if (lower.includes("врем")) {
      return tools.getTime();
    }

    if (lower === "/uuid") {
      return tools.generateUuid();
    }

    if (lower === "/random") {
      return String(
    tools.randomNumber());
    }

    if (lower.startsWith("/search-web ")) {
      return await this.searchWeb(text.slice(12).trim());
    }

     if (lower.startsWith("/base64 ")) {
       const textToEncode =
    text.slice(8).trim();

  return tools.encodeBase64(
    textToEncode );
    }

    if (lower.startsWith("/weather ")) {
      return await this.weather(text.slice(9).trim());
    }

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
   * @param {string} text
   * @param {string} lower
   * @returns {Promise<string>}
   */
  async askAi(text, lower) {
    
    const memories = memory.getAll();

    let agentRole = AGENTS.default;
    let cleanText = text;

    if (lower.startsWith("/search ")) {
       return await this.search(text.slice(8).trim());
    }

    if (lower.startsWith("/coder")) {
      agentRole = AGENTS.coder;
      cleanText = text.replace("/coder", "").trim();
    }

    if (lower.startsWith("/architect")) {
      agentRole = AGENTS.architect;
      cleanText = text.replace("/architect", "").trim();
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
    
    const answer = await askModel(messages);

    this.conversationHistory.push({
      role: "assistant",
      content: answer
    });
    // сохраняем ответ агента

    if (this.conversationHistory.length > 20) {
      this.conversationHistory =
        this.conversationHistory.slice(-20);
    }
    // оставляем последние 20 сообщений

    return answer;
  }

  /**
   * @param {string} query
   * @returns {Promise<string>}
   */
  async search(query) {
  // search — исследовательский режим

  if (!query) {
    return "Напиши запрос. Например: /search что такое MCP сервер";
  }

  const memories = memory.getAll();

  const messages = [
    {
      role: "system",
      content: `Ты исследовательский AI-агент.

Твоя задача:
- объяснять тему структурно
- отделять факты от предположений
- предупреждать, если нужна свежая проверка в интернете
- давать практические шаги
- отвечать простым языком

Память:
${memories.join("\n")}`
    },
    {
      role: "user",
      content: query
    }
  ];

  const answer = await askModel(messages);

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
      return "Напиши, что именно запомнить. Например: запомни я учу JavaScript";
    }

    memory.save(text);
    return "Запомнил: " + text;
  }

  /**
   * @returns {string}
   */
  recall() {
    const all = memory.getAll();

    if (all.length === 0) {
      return "Пока ничего не помню. Мозг чистый, как новая база данных.";
    }

    return all.join("\n");
  }

  /**
   * @returns {string}
   */
  history() {
    const all = memory.getAll();

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
      const success = memory.remove(number - 1);

      if (!success) {
        return "Запись с таким номером не найдена.";
      }

      return `Удалил запись №${number}`;
    }

    const success = memory.removeByText(value);

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
    "/base64"
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

  memory.save(lastUserMessage.content);
  // сохраняем текст в долговременную память

  return `Запомнил: ${lastUserMessage.content}`;
}

  /**
   * @param {string} expression
   * @returns {string}
   */
  calculate(expression) {
    const result = tools.calculate(expression);
    return String(result);
  }

}

export default Agent;

/**
 * @param {string} text
 * @returns {void}
 */
function remember(text) {
  throw new Error("Function not implemented.");
}
