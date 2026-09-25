import "dotenv/config";

import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";

import Agent from "./src/agent.js";
import { startTelegramBot } from "./src/telegram.js";
import { createWebApp } from "./src/web.js";
import {
  closeDatabase,
  initDatabase
} from "./src/database.js";
import { assertDataDirWritable } from "./src/utils/dataDir.js";
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
    await closeDatabase();
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

// Синхронно и до HTTP-листенера ниже: async main().catch() только
// выставляет process.exitCode, а модуль продолжает выполняться дальше —
// webApp.listen() поднялся бы всё равно, и /health отвечал бы "жив" при
// нерабочем DATA_DIR. Явный process.exit(1) не оставляет такого зомби.
try {
  assertDataDirWritable();
} catch (error) {
  logError("DATA_DIR недоступен для записи, выходим:", error);
  process.exit(1);
}

main().catch(error => {
  logError("Ошибка запуска:", error);
  process.exitCode = 1;
});

/**
 * PORT иногда приходит не голым числом (например "0.0.0.0:10000" из
 * скопированной docker-строки) — Number.parseInt на таком молча даёт 0,
 * а порт 0 для Node значит "выбери случайный свободный порт". Достаём
 * число даже из хвоста строки, чтобы не слушать порт непредсказуемо.
 * @param {string|undefined} value
 * @returns {number}
 */
function resolveHttpPort(value) {
  const match = String(value ?? "").match(/(\d+)\s*$/);
  const port = match ? Number.parseInt(match[1], 10) : NaN;

  return Number.isInteger(port) && port > 0 ? port : 10000;
}

const HTTP_PORT = resolveHttpPort(process.env.PORT);

// Тот же порт, что Render проверяет health-check'ом, теперь отдаёт и
// веб-интерфейс: заглушку на "жив ли процесс" заменил настоящий продукт.
const webApp = createWebApp();

const webServer = webApp.listen(HTTP_PORT, "0.0.0.0", () => {
  const address = webServer.address();
  const boundPort = typeof address === "object" && address ? address.port : HTTP_PORT;

  logInfo(`🌐 Веб-интерфейс и health-check на порту ${boundPort}`);
});
