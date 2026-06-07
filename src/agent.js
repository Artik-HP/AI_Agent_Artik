import * as memory from "./memory.js";
// import — подключаем код из другого файла
// * as memory — берём всё из memory.js и называем memory
// "./memory.js" — путь к файлу памяти

import * as tools from "./tools.js";
// * as tools — берём всё из tools.js и называем tools

import { askModel } from "./model.js";
// { askModel } — берём конкретную функцию askModel из model.js

/**
 * @typedef {Object} AgentData
 */

/**
 * @typedef {string} ProcessResult
 */

const MEMORY_COMMANDS = new Set([
  "что ты помнишь",
  "что ты помниш",
  "память"
]);
// new Set([...]) — список уникальных команд памяти
const AGENTS = {
 
  default: "Ты полезный AI-агент. Отвечай подробно, простым языком и помогай изучать JavaScript.",
 
  coder: "Ты JavaScript-наставник. Объясняй код подробно, простым языком, с комментариями прямо в коде.",

  architect: "Ты архитектор AI-агентов. Помогай проектировать структуру, память, инструменты и интеграции."
};

const HELP_TEXT = [
  "Доступные команды:",
  "/help — помощь",
  "/agents — список агентов",
  "/coder — режим наставника",
  "/architect — режим архитектора",
  "/clear — очистить память",
  "запомни [текст] — сохранить в память",
  "что ты помнишь — вывести память",
  "calc [выражение] — калькулятор",
  "время — текущее время"
].join("\n");

class Agent {
  /**
   * @param {string|null|undefined} message
   * @returns {Promise<ProcessResult>}
   */
  async process(message) {
    const text = String(message || "").trim();
    // String(...) — превращаем сообщение в строку
    // message || "" — если message пустой, берём пустую строку
    // trim() — убираем пробелы по краям

    const lower = text.toLowerCase();
    // toLowerCase() — переводим текст в нижний регистр

    if (!text) {
      return "Напиши команду или вопрос.";
    }

   if (lower === "/help") {
  // если пользователь написал /help

  return HELP_TEXT;
  // возвращаем текст помощи
}

   if (lower === "/agents") {
  // если пользователь написал /agents

  return [
    "Доступные агенты:",
    "/coder — JavaScript-наставник",
    "/architect — архитектор AI-агентов"
  ].join("\n");
  // join("\n") — склеивает строки через перенос
}

  if (lower === "/clear") {
  // если пользователь написал /clear

  memory.clear();
  // очищаем память

  return "Память очищена.";
  // отвечаем пользователю
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

    const memories = memory.getAll();
let agentRole = AGENTS.default;
let cleanText = text;

if (lower.startsWith("/coder")) {
  agentRole = AGENTS.coder;
  cleanText = text.replace("/coder", "").trim();
}

if (lower.startsWith("/architect")) {
  agentRole = AGENTS.architect;
  cleanText = text.replace("/architect", "").trim();
}
    const messages = [
      {
        role: "system",
content:
`${agentRole}

Память:
${memories.join("\n")}`
      },
      {
        role: "user",
        content: cleanText
      }
    ];

    return await askModel(messages);
  }

  /**
   * @param {string} text
   * @returns {string}
   */
  remember(text) {
    if (!text) {
      return [
        "Напиши, что именно запомнить.",
        "Например: запомни я учу JavaScript"
      ].join(" ");
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
      return [
        "Пока ничего не помню.",
        "Мозг чистый, как новая база данных."
      ].join(" ");
    }

    return all.join("\n");
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

// removed stray unused function
// export default — экспортируем класс Agent как главный экспорт файла