import { createInterface } from "node:readline";
// импорт readline из Node.js

import Agent from "./src/agent.js";
// импортируем класс Agent

const agent = new Agent();
// создаём экземпляр агента

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

const isInteractive = Boolean(process.stdin.isTTY);

async function main() {
  if (isInteractive) {
    rl.setPrompt("Ты: ");
    rl.prompt();
  }

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

    if (isInteractive) {
      rl.prompt();
    }
  }
}

main().catch((error) => {
  console.error("Агент: Ошибка:", error.message);
  process.exitCode = 1;
});
