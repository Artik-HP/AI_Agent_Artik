import { Telegraf } from "telegraf";
import Agent from "./agent.js";
import { splitMessage }
  from "./utils/splitMessage.js";

const agents = new Map();

function getAgent(chatId) {
  if (!agents.has(chatId)) {
    agents.set(chatId, new Agent(chatId));
  }

  return agents.get(chatId);
}

export async function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN не найден"
    );
  }

  const bot = new Telegraf(token);

  bot.start(ctx => {
    return ctx.reply(
      "Привет! Я AI_Agent_JS 🤖"
    );
  });

  bot.on("text", async ctx => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;

    console.log(
      "Chat:",
      chatId,
      "Text:",
      userText
    );

    try {
      const agent = getAgent(chatId);

      const answer =
        await agent.process(userText);

const parts = splitMessage(answer);

for (const part of parts) {
  await ctx.reply(part);
}

} catch (error) {
      console.error(error);

      await ctx.reply(
        "Ошибка: " +
        String(error.message || error)
      );
    }
  });

  await bot.launch();

  console.log(
    "Telegram bot started"
  );
}