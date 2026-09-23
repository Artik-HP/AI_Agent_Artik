import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import express from "express";

import Agent from "./agent.js";
import * as memory from "./memory.js";
import { CRITERIA_PRESETS, EXCEL_ACTIONS } from "./telegram.js";
import { sanitizeFileName } from "./utils/fileNames.js";
import { logError } from "./utils/logger.js";
import { getDocumentReply, getImageReply } from "./utils/replyFiles.js";

const SESSION_COOKIE = "artik_sid";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const EXPORTS_DIR = path.resolve(process.cwd(), "exports");
const UPLOAD_ROOT = path.resolve(process.cwd(), "data", "web");
const PUBLIC_DIR = path.resolve(process.cwd(), "public");
const SPREADSHEET_EXTENSIONS = new Set([".csv", ".xls", ".xlsx"]);

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
 * @param {string} sessionId
 * @returns {Agent}
 */
function getSessionAgent(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, new Agent(toChatId(sessionId)));
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
 * Достаёт id сессии из cookie или заводит новую — так же, как Telegram
 * получает chatId из апдейта: один раз на первое сообщение.
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @returns {string}
 */
function ensureSession(req, res) {
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

  app.get("/api/quick-actions", (req, res) => {
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

  app.post("/api/chat", async (req, res) => {
    const sessionId = ensureSession(req, res);
    const message = String(req.body?.message || "").trim();

    if (!message) {
      res.status(400).json({ error: "Пустое сообщение." });
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

  app.post("/api/upload", async (req, res) => {
    const sessionId = ensureSession(req, res);
    const body = req.body || {};
    const originalName = String(body.filename || "");
    const contentBase64 = String(body.contentBase64 || "");

    if (!SPREADSHEET_EXTENSIONS.has(path.extname(originalName).toLowerCase())) {
      res.status(400).json({
        error: "Принимаю только Excel/CSV: .xlsx, .xls или .csv."
      });
      return;
    }

    let buffer;

    try {
      buffer = Buffer.from(contentBase64, "base64");
    } catch {
      res.status(400).json({ error: "Не смог прочитать файл." });
      return;
    }

    if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: "Файл пустой или больше 15 МБ." });
      return;
    }

    try {
      const uploadDir = path.join(UPLOAD_ROOT, sessionId);

      fs.mkdirSync(uploadDir, { recursive: true });

      const fileName = `${Date.now()}-${sanitizeFileName(originalName)}`;
      const filePath = path.join(uploadDir, fileName);

      fs.writeFileSync(filePath, buffer);

      const projectPath = path
        .relative(process.cwd(), filePath)
        .split(path.sep)
        .join("/");

      await memory.save(
        `Excel файл загружен: ${projectPath}`,
        toChatId(sessionId)
      );

      res.json({
        message: `Файл получен: ${projectPath}. Выбери действие ниже или напиши, что сделать.`
      });
    } catch (error) {
      logError("Ошибка веб-загрузки файла:", error);
      res.status(500).json({ error: "Не удалось сохранить файл." });
    }
  });

  // Отдаём только то, что бот сам сформировал в exports/ — ни листинга,
  // ни вложенных путей: имя файла проверяем от выхода за пределы каталога.
  app.get("/files/:filename", (req, res) => {
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
