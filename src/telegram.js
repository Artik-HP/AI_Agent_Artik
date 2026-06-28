import { Markup, Telegraf } from "telegraf";
import Agent from "./agent.js";
import {
  detectAudioFormat,
  transcribeAudio
} from "./tools/speech.js";
import { splitMessage }
  from "./utils/splitMessage.js";

const agents = new Map();

const MAIN_KEYBOARD = Markup.keyboard([
  [
    "Агент: default",
    "Агент: coder",
    "Агент: architect"
  ],
  [
    "Нарисовать картинку",
    "Команды"
  ]
]).resize();

const BUTTON_COMMANDS = new Map([
  ["Агент: default", "/agent default"],
  ["Агент: coder", "/agent coder"],
  ["Агент: architect", "/agent architect"],
  ["Нарисовать картинку", "/draw"],
  ["Команды", "/commands"]
]);

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

/**
 * @param {import("telegraf").Context} ctx
 * @param {string} answer
 */
async function replyInParts(ctx, answer) {
  const parts = splitMessage(answer, 3900);

  console.log(
    "PARTS:",
    parts.length
  );

  for (const [index, part] of parts.entries()) {
    if (index === 0) {
      await ctx.reply(part, MAIN_KEYBOARD);
      continue;
    }

    await ctx.reply(part);
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeTelegramText(text) {
  return BUTTON_COMMANDS.get(text) || text;
}

/**
 * @param {string} answer
 * @returns {{url: string, caption: string}|null}
 */
function getImageReply(answer) {
  const match = answer.match(
    /^Картинка готова:\n(https:\/\/image\.pollinations\.ai\/\S+)/m
  );

  if (!match) {
    return null;
  }

  const promptMatch = answer.match(/\nПромпт: ([\s\S]+)$/);
  const prompt = String(promptMatch?.[1] || "").trim();
  const caption = prompt
    ? `Картинка готова.\nПромпт: ${prompt.slice(0, 900)}`
    : "Картинка готова.";

  return {
    url: match[1],
    caption
  };
}

/**
 * @param {import("telegraf").Context} ctx
 * @param {string} answer
 */
async function replyAgentAnswer(ctx, answer) {
  const imageReply = getImageReply(answer);

  if (!imageReply) {
    await replyInParts(ctx, answer);
    return;
  }

  try {
    await ctx.replyWithPhoto(
      imageReply.url,
      {
        caption: imageReply.caption,
        ...MAIN_KEYBOARD
      }
    );
  } catch (error) {
    console.error("Telegram image reply error:", error);
    await replyInParts(ctx, answer);
  }
}

/**
 * @param {string} fileId
 * @param {import("telegraf").Context} ctx
 * @returns {Promise<Buffer>}
 */
async function downloadTelegramFile(fileId, ctx) {
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(fileLink);

  if (!response.ok) {
    throw new Error(
      `Не удалось скачать аудио из Telegram: ${response.status}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * @param {import("telegraf").Context} ctx
 */
async function handleTextMessage(ctx) {
  console.log("TEXT FROM TELEGRAM:", ctx.message.text);
  console.log("CHAT ID:", ctx.chat.id);
  const chatId = ctx.chat.id;
  const userText = normalizeTelegramText(ctx.message.text);

  try {
    const agent = getAgent(chatId);
    const answer = await agent.process(userText);

    console.log("ANSWER LENGTH:", answer.length);
    await replyAgentAnswer(ctx, answer);
  } catch (error) {
    await handleTelegramError(ctx, error);
  }
}

/**
 * @param {import("telegraf").Context} ctx
 */
async function handleSpeechMessage(ctx) {
  const message = ctx.message;
  const audio = message.voice || message.audio;
  const chatId = ctx.chat.id;

  if (!audio) {
    return;
  }

  try {
    await ctx.reply("Распознаю голос...");

    const audioBuffer = await downloadTelegramFile(audio.file_id, ctx);
    const text = await transcribeAudio(audioBuffer, {
      format: detectAudioFormat(audio.mime_type, audio.file_name),
      language: process.env.OPENROUTER_STT_LANGUAGE || process.env.STT_LANGUAGE
    });

    console.log("VOICE TRANSCRIPT:", text);

    const agent = getAgent(chatId);
    const answer = await agent.process(text);

    await ctx.reply(`Распознал: ${text}`);
    await replyAgentAnswer(ctx, answer);
  } catch (error) {
    await handleTelegramError(ctx, error);
  }
}

/**
 * @param {import("telegraf").Context} ctx
 * @param {unknown} error
 */
async function handleTelegramError(ctx, error) {
  console.error("Telegram handler error:", error);

  const message = error instanceof Error ? error.message : String(error);

  await ctx.reply(
    "Ошибка: " + message
  );
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
      "Привет! Я AI_Agent_JS 🤖\nВыбери агента, открой команды или попроси нарисовать картинку.",
      MAIN_KEYBOARD
    );
  });

  bot.on("text", handleTextMessage);
  bot.on("voice", handleSpeechMessage);
  bot.on("audio", handleSpeechMessage);

  await bot.launch();

  console.log(
    "Telegram bot started"
  );
}
