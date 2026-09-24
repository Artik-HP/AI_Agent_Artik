import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import express from "express";

import Agent from "./agent.js";
import { CRITERIA_PRESETS, EXCEL_ACTIONS } from "./telegram.js";
import { dataPath } from "./utils/dataDir.js";
import { logError } from "./utils/logger.js";
import { checkPublicRateLimit } from "./utils/rateLimit.js";
import { getDocumentReply, getImageReply } from "./utils/replyFiles.js";
import { readTrustedSessionId, requireAgentKey } from "./utils/webAuth.js";

const SESSION_COOKIE = "artik_sid";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
// exports/ — пользовательские данные, живёт на DATA_DIR (по умолчанию
// совпадает с process.cwd(), см. utils/dataDir.js). public/ — статика
// сайта, часть кода, деплой пересоздаёт её каждый раз — остаётся на
// process.cwd() намеренно, DATA_DIR её не трогает. Excel-загрузок здесь
// больше нет (см. /api/upload ниже) — UPLOAD_ROOT/data/web/ не нужны.
const EXPORTS_DIR = dataPath("exports");
const PUBLIC_DIR = path.resolve(process.cwd(), "public");

/**
 * Одна сессия браузера — один Agent, как в Telegram один чат — один Agent.
 * Префикс "web:" не даёт id сессии случайно совпасть с Telegram chat_id.
 * @type {Map<string, Agent>}
 */
const sessions = new Map();

/**
 * @param {string} sessionId
 * @returns {string}
 */
function toChatId(sessionId) {
  return `web:${sessionId}`;
}

/**
 * Веб-поверхность теперь всегда публичный демо-режим (ограниченные
 * инструменты, отдельная персона — см. options.publicMode в agent.js). Полный
 * доступ владельца остаётся на Telegram и CLI, как и было основным способом
 * работы с ботом; веб-чат в одиночку никогда не проходил аутентификацию (см.
 * requireAgentKey ниже), так что различать «владелец в браузере» и
 * «анонимный посетитель» здесь нет смысла — оба видны серверу одинаково.
 * @param {string} sessionId
 * @returns {Agent}
 */
function getSessionAgent(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, new Agent(toChatId(sessionId), { publicMode: true }));
  }

  return /** @type {Agent} */ (sessions.get(sessionId));
}

/**
 * @param {import("express").Request} req
 * @returns {string|null}
 */
function readSessionCookie(req) {
  const header = String(req.headers.cookie || "");
  const match = header.match(/(?:^|;\s*)artik_sid=([a-zA-Z0-9-]+)/);

  return match ? match[1] : null;
}

/**
 * Достаёт id сессии из доверенного заголовка (портфолио-прокси сам ведёт
 * сессию и прокидывает её id явно — cookie браузера до сервера агента в
 * server-to-server fetch всё равно не доходит), иначе из cookie, иначе
 * заводит новую — так же, как Telegram получает chatId из апдейта: один раз
 * на первое сообщение.
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @returns {string}
 */
function ensureSession(req, res) {
  const trusted = readTrustedSessionId(req);

  if (trusted) {
    return trusted;
  }

  const existing = readSessionCookie(req);

  if (existing) {
    return existing;
  }

  const sessionId = crypto.randomUUID();

  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`
  );

  return sessionId;
}

/**
 * Превращает текстовый ответ агента в JSON для фронтенда: те же
 * сентинел-строки ("Excel-файл:", "Картинка-файл:"), что понимает Telegram,
 * тут становятся ссылкой на скачивание вместо файла в чат.
 * @param {string} answer
 * @returns {{reply: string, file?: {name: string, url: string}, image?: {url: string}}}
 */
function formatAnswer(answer) {
  const text = String(answer);
  const document = getDocumentReply(text);

  if (document) {
    return {
      reply: document.caption,
      file: {
        name: document.fileName,
        url: `/files/${encodeURIComponent(document.fileName)}`
      }
    };
  }

  const image = getImageReply(text);

  if (image) {
    const fileName = path.basename(image.filePath);

    return {
      reply: image.caption,
      image: {
        url: `/files/${encodeURIComponent(fileName)}`
      }
    };
  }

  return { reply: text };
}

/**
 * @returns {import("express").Express}
 */
export function createWebApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "20mb" }));
  app.use(express.static(PUBLIC_DIR));

  app.get("/health", (req, res) => {
    res.type("text/plain").send("AI Agent Artik Bot is alive 🚀");
  });

  app.get("/api/quick-actions", requireAgentKey, (req, res) => {
    res.json({
      actions: EXCEL_ACTIONS.map(action => ({
        id: action.id,
        label: action.label,
        phrase: action.phrase || null,
        hint: action.hint || null,
        menu: action.menu || null
      })),
      criteria: CRITERIA_PRESETS
    });
  });

  app.post("/api/chat", requireAgentKey, async (req, res) => {
    const sessionId = ensureSession(req, res);
    const message = String(req.body?.message || "").trim();

    if (!message) {
      res.status(400).json({ error: "Пустое сообщение." });
      return;
    }

    const rateLimit = checkPublicRateLimit(req);

    if (!rateLimit.allowed) {
      res.status(429).json({
        error: rateLimit.reason === "daily"
          ? "Демо-чат сегодня уже исчерпал общий лимит сообщений. Загляни завтра."
          : "Слишком много сообщений подряд. Попробуй через час."
      });
      return;
    }

    try {
      const agent = getSessionAgent(sessionId);
      const answer = await agent.process(message);

      res.json(formatAnswer(String(answer)));
    } catch (error) {
      logError("Ошибка веб-чата:", error);
      res.status(500).json({
        error: "Что-то сломалось на сервере. Попробуй ещё раз."
      });
    }
  });

  // Публичный веб-виджет не даёт доступ к excel-инструменту (см. publicMode
  // в agent.js) — принимать файлы, которые агент всё равно не сможет
  // обработать, было бы лишней поверхностью для атак без пользы. Загрузка
  // Excel/CSV остаётся в Telegram — там она полноценно работает.
  app.post("/api/upload", requireAgentKey, (req, res) => {
    res.status(403).json({
      error: "Загрузка файлов недоступна в публичном демо-чате. Это доступно владельцу в Telegram."
    });
  });

  // Отдаём только то, что бот сам сформировал в exports/ — ни листинга,
  // ни вложенных путей: имя файла проверяем от выхода за пределы каталога.
  app.get("/files/:filename", requireAgentKey, (req, res) => {
    const fileName = req.params.filename;

    if (!fileName || /[\\/]/.test(fileName) || fileName.includes("..")) {
      res.status(400).send("Некорректное имя файла.");
      return;
    }

    const filePath = path.join(EXPORTS_DIR, fileName);

    if (!filePath.startsWith(EXPORTS_DIR + path.sep) || !fs.existsSync(filePath)) {
      res.status(404).send("Файл не найден или уже удалён.");
      return;
    }

    res.download(filePath, fileName);
  });

  return app;
}
