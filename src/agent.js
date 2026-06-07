const memory = require("./memory");
const tools = require("./tools");

/**
 * @typedef {Object} IAgent
 * @property {(message: string | null | undefined) => Promise<string>} process
 * @property {(text: string) => string} remember
 * @property {() => string} recall
 * @property {(expression: string) => string} calculate
 */

const MEMORY_COMMANDS = new Set([
  "что ты помнишь",
  "что ты помниш",
  "память"
]);

class Agent {
  /**
   * @param {string | null | undefined} message
   * @returns {Promise<string>}
   */
  async process(message) {
    const text = String(message || "").trim();
    const lower = text.toLowerCase();

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

    return "Я пока умею: запомни ..., память, calc 2 + 2, спросить время.";
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

module.exports = Agent;
