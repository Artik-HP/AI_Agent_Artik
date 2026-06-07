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

    const messages = [
      {
        role: "system",
        content:
          "Ты полезный AI-агент. Отвечай подробно, простым языком и помогай изучать JavaScript."
      },
      {
        role: "user",
        content: text
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
// export default — экспортируем класс Agent как главный экспорт файла