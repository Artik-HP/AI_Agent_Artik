import http from "node:http";

import "dotenv/config";

import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";

import Agent from "./src/agent.js";
import { startTelegramBot } from "./src/telegram.js";
import {
  initDatabase
} from "./src/database.js";
import { installCrashHandlers, logError, logInfo } from "./src/utils/logger.js";

// Ставим до всего остального: падение на старте тоже должно оставить след.
installCrashHandlers();

/**
 * @typedef {Object} ErrorResponse
 * @property {string} message
 */

/**
 * @typedef {Object} CLIState
 * @property {Agent} agent
 * @property {import('node:readline').Interface} rl
 * @property {boolean} isInteractive
 */

/** @type {string} */
const TELEGRAM_FLAG = "--telegram";
/** @type {Set<string>} */
const EXIT_COMMANDS = new Set(["exit", "quit", "выход"]);

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function main() {
  await initDatabase();

  const isTelegramMode =
    process.argv.includes(TELEGRAM_FLAG);

  if (isTelegramMode) {
    await runTelegramBot();

    return;
  }

  try {
    await runCli();
  } finally {
   // await closeDatabase();
  }
}

async function runTelegramBot() {
  await startTelegramBot();
  logInfo("Бот работает, ждём сообщения.");
  process.stdin.resume();
}

async function runCli() {
  const agent = new Agent();
  const rl = createInterface({
    input,
    output,
    prompt: "Ты: "
  });
  const isInteractive = Boolean(input.isTTY && output.isTTY);

  try {
    if (isInteractive) {
      console.log("AI Agent запущен. Напиши вопрос или команду. Для выхода: exit");
      rl.prompt();
    }

    for await (const message of rl) {
      const command = message.trim().toLowerCase();

      if (EXIT_COMMANDS.has(command)) {
        if (isInteractive) {
          console.log("Пока.");
        }
        break;
      }

      if (!command) {
        if (isInteractive) {
          rl.prompt();
        }
        continue;
      }

      try {
        const reply = await agent.process(message);
        console.log(`Агент: ${reply}`);
      } catch (error) {
        console.error(`Агент: Ошибка: ${getErrorMessage(error)}`);
      }

      if (isInteractive) {
        rl.prompt();
      }
    }
  } finally {
    rl.close();
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */

main().catch(error => {
  logError("Ошибка запуска:", error);
  process.exitCode = 1;
});

const HTTP_PORT = Number.parseInt(process.env.PORT ?? "10000", 10);

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
  });

  res.end("AI Agent Artik Bot is alive 🚀");
});

server.listen(HTTP_PORT, "0.0.0.0", () => {
  console.log(`🌐 Render HTTP server running on port ${HTTP_PORT}`);
});
