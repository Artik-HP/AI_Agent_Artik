import { Telegraf } from "telegraf";
import Agent from "./agent.js";
import { splitMessage }
  from "./utils/splitMessage.js";

const agents = new Map();

/**
 * @param {string | number | undefined} chatId
 */
function getAgent(chatId) {
  if (!agents.has(chatId)) {
    const agentId = chatId !== undefined ? String(chatId) : undefined;
    agents.set(chatId, new Agent(agentId));
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
    console.log("TEXT FROM TELEGRAM:", ctx.message.text);
    console.log("CHAT ID:", ctx.chat.id);
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;

    try {
      const agent = getAgent(chatId);
      const answer = await agent.process(userText);

      console.log("ANSWER LENGTH:", answer.length);

const parts = splitMessage(answer, 3900);
      console.log(
        "PARTS:",
        parts.length
      );

      for (const part of parts) {
        await ctx.reply(part);
      }
    } catch (error) {
      console.error("Telegram handler error:", error);

      const message = error instanceof Error ? error.message : String(error);

      await ctx.reply(
        "Ошибка: " + message
      );
    }
  });
  await bot.launch();

  console.log(
    "Telegram bot started"
  );
}