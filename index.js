import "dotenv/config";
// загружаем .env

import { createInterface } from "node:readline";
// createInterface — консольный ввод

import Agent from "./src/agent.js";
// наш агент

import { startTelegramBot } from "./src/telegram.js";
// запуск Telegram

const isTelegramMode = process.argv.includes("--telegram");
// проверяем, есть ли флаг --telegram

if (isTelegramMode) {
  await startTelegramBot();
  // запускаем только Telegram

  process.stdin.resume();
  // держим процесс живым
} else {
  await startCli();
  // иначе запускаем только консоль
}

async function startCli() {
  const agent = new Agent();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.setPrompt("Ты: ");
  rl.prompt();

  for await (const message of rl) {
    const command = message.trim().toLowerCase();

    if (command === "exit" || command === "выход") {
      break;
    }

    try {
      const reply = await agent.process(message);
      console.log("Агент:", reply);
    } catch (error) {
      console.error("Агент: Ошибка:", error.message);
    }

    rl.prompt();
  }

  rl.close();
}