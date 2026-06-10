import { Telegraf } from "telegraf";
// Telegraf — библиотека для Telegram-ботов

import Agent from "./agent.js";


export async function startTelegramBot() {
  console.log("startTelegramBot called");

  const token = process.env.TELEGRAM_BOT_TOKEN;

  console.log("Token exists:", !!token);

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN не найден в .env");
  }

  const bot = new Telegraf(token);
const agents = new Map();
// Map — хранилище: chatId → Agent

function getAgent(chatId) {
  if (!agents.has(chatId)) {
    agents.set(chatId, new Agent());
  }

  return agents.get(chatId);
}
  bot.start(ctx => {
    return ctx.reply(
      "Привет! Я AI-агент. Напиши /help, чтобы увидеть команды."
    );
  });

  bot.on("text", async ctx => {
    console.log("Telegram message:", ctx.message.text);

    const userText = ctx.message.text;

    try {
      const chatId = ctx.chat.id;
      const agent = getAgent(chatId);
      const answer = await agent.process(userText);  
      return ctx.reply(answer);
    } catch (error) {
      return ctx.reply("Ошибка: " + String(error.message || error));
    }
  });

  console.log("Launching bot...");
  await bot.launch();
  console.log("Telegram bot started");
}