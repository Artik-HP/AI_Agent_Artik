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
const WEB_APP_URL = String(process.env.WEB_APP_URL || "").trim().replace(/\/+$/, "");
const WEB_APP_USERNAME = String(process.env.WEB_APP_USERNAME || "artik");
const WEB_APP_PASSWORD = String(process.env.WEB_APP_PASSWORD || "");
const EXPORTS_DIR = path.resolve(process.cwd(), "exports");
const UPLOAD_ROOT = path.resolve(process.cwd(), "data", "web");
const PUBLIC_DIR = path.resolve(process.cwd(), "public");
const SPREADSHEET_EXTENSIONS = new Set([".csv", ".xls", ".xlsx"]);
const AUTH_COOKIE = "artik_auth";
const AUTH_TTL = 60 * 60 * 24 * 7;
const loginAttempts = new Map();

function authSignature(expires) {
  return crypto.createHmac("sha256", `${WEB_APP_USERNAME}:${WEB_APP_PASSWORD}`)
    .update(String(expires)).digest("hex");
}

function loginPage(error = "") {
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вхід · AI Agent</title><style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#eef2ff;font:16px system-ui,sans-serif;padding:20px}main{width:min(100%,390px);padding:32px;border:1px solid #334155;border-radius:20px;background:#172033;box-shadow:0 20px 60px #0005}h1{margin:0 0 8px;font-size:28px}p{color:#aab8cf;margin:0 0 28px}label{display:block;margin:18px 0 7px}input{width:100%;padding:13px 14px;border-radius:10px;border:1px solid #64748b;background:#0b1020;color:white;font:inherit}input:focus{outline:2px solid #67e8f9}button{width:100%;margin-top:26px;padding:14px;border:0;border-radius:10px;background:#67e8f9;color:#08202c;font:600 16px system-ui;cursor:pointer}.error{color:#fca5a5;margin:16px 0 0}
  </style></head><body><main><h1>AI Agent</h1><p>Вхід у вебінтерфейс</p><form method="post" action="/login"><label for="username">Логін</label><input id="username" name="username" autocomplete="username" required><label for="password">Пароль</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Увійти</button></form>${error ? '<p class="error" role="alert">Невірний логін або пароль. Спробуй ще раз.</p>' : ""}</main></body></html>`;
}

function credentialsMatch(username, password) {
  const expectedUser = Buffer.from(WEB_APP_USERNAME);
  const actualUser = Buffer.from(username);
  const expectedPassword = Buffer.from(WEB_APP_PASSWORD);
  const actualPassword = Buffer.from(password);
  return actualUser.length === expectedUser.length &&
    crypto.timingSafeEqual(actualUser, expectedUser) &&
    actualPassword.length === expectedPassword.length &&
    crypto.timingSafeEqual(actualPassword, expectedPassword);
}

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

  app.use((req, res, next) => {
    if (req.path === "/health") {
      next();
      return;
    }

    if (WEB_APP_URL.startsWith("https://")) {
      const forwardedProtocol = String(req.headers["x-forwarded-proto"] || "")
        .split(",")[0]
        .trim();
      const protocol = forwardedProtocol || req.protocol;

      if (protocol !== "https") {
        res.redirect(308, `${WEB_APP_URL}${req.originalUrl}`);
        return;
      }
    }

    if (!WEB_APP_PASSWORD) {
      if (process.env.NODE_ENV === "production") {
        res.status(503).type("text/plain").send("Веб-интерфейс не настроен: задай WEB_APP_PASSWORD.");
        return;
      }

      next();
      return;
    }

    if (req.path === "/login" && req.method === "GET") {
      res.setHeader("Cache-Control", "no-store");
      res.type("html").send(loginPage());
      return;
    }

    if (req.path === "/login" && req.method === "POST") {
      express.urlencoded({ extended: false, limit: "4kb" })(req, res, () => {
        const ip = req.ip || req.socket.remoteAddress || "unknown";
        const record = loginAttempts.get(ip) || { count: 0, until: 0 };
        if (record.until > Date.now() && record.count >= 10) {
          res.status(429).type("text/plain").send("Забагато спроб. Спробуй через 15 хвилин.");
          return;
        }
        if (credentialsMatch(String(req.body?.username || ""), String(req.body?.password || ""))) {
          loginAttempts.delete(ip);
          const expires = Math.floor(Date.now() / 1000) + AUTH_TTL;
          res.setHeader("Set-Cookie", `${AUTH_COOKIE}=${expires}.${authSignature(expires)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${AUTH_TTL}`);
          res.redirect(303, "/");
          return;
        }
        const count = record.until > Date.now() ? record.count + 1 : 1;
        loginAttempts.set(ip, { count, until: Date.now() + 15 * 60 * 1000 });
        res.setHeader("Cache-Control", "no-store");
        res.status(401).type("html").send(loginPage(true));
      });
      return;
    }

    const cookie = String(req.headers.cookie || "").match(/(?:^|;\s*)artik_auth=(\d+)\.([a-f0-9]{64})(?:;|$)/);
    if (cookie && Number(cookie[1]) > Math.floor(Date.now() / 1000)) {
      const expected = Buffer.from(authSignature(cookie[1]), "hex");
      if (crypto.timingSafeEqual(Buffer.from(cookie[2], "hex"), expected)) {
        next();
        return;
      }
    }

    const authorization = String(req.headers.authorization || "");
    const match = authorization.match(/^Basic\s+(.+)$/i);
    let suppliedUsername = "";
    let suppliedPassword = "";

    if (match) {
      const credentials = Buffer.from(match[1], "base64").toString("utf8");
      const separatorIndex = credentials.indexOf(":");

      if (separatorIndex >= 0) {
        suppliedUsername = credentials.slice(0, separatorIndex);
        suppliedPassword = credentials.slice(separatorIndex + 1);
      }
    }

    if (credentialsMatch(suppliedUsername, suppliedPassword)) {
      next();
      return;
    }

    if (req.method === "GET" && !req.path.startsWith("/api/") && !req.path.startsWith("/files/")) {
      res.redirect(302, "/login");
      return;
    }
    res.status(401).json({ error: "Потрібен вхід у вебінтерфейс." });
  });

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
