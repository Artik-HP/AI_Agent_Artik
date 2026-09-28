import fs from "node:fs";

import {
  initDatabase,
  isDatabaseConfigured,
  dbQuery
} from "./database.js";
import { dataPath, dataRoot } from "./utils/dataDir.js";

/**
 * Регистрация доступа к Telegram-боту по коду. Кто прислал верный код через
 * /start, тот записывается сюда и дальше считается разрешённым — наравне со
 * статическим списком ALLOWED_CHAT_IDS из .env (см. telegram.js). Тот же
 * dual-mode паттерн, что и у memory.js/projects.js: таблица bot_users в
 * PostgreSQL при заданной DATABASE_URL, иначе файл bot_users.json.
 */

/**
 * @typedef {Object} BotUserRecord
 * @property {string} username
 * @property {string} role
 * @property {boolean} isActive
 * @property {string} createdAt
 */

// Файловый fallback (без DATABASE_URL) — на DATA_DIR, как memory.json/projects.json.
const BOT_USERS_FILE = dataPath("bot_users.json");

/** @type {Record<string, BotUserRecord>} */
let store = load();
/** @type {boolean} */
let databaseReady = false;

/**
 * @returns {Record<string, BotUserRecord>}
 */
function load() {
  if (!fs.existsSync(BOT_USERS_FILE)) {
    return {};
  }

  const raw = fs.readFileSync(BOT_USERS_FILE, "utf8");

  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

/**
 * @returns {void}
 */
function persistFile() {
  fs.mkdirSync(dataRoot(), { recursive: true });
  fs.writeFileSync(BOT_USERS_FILE, JSON.stringify(store, null, 2), "utf8");
}

/**
 * @param {string | number} chatId
 * @returns {string}
 */
function getKey(chatId) {
  return String(chatId);
}

/**
 * @returns {Promise<boolean>}
 */
async function shouldUseDatabase() {
  if (!isDatabaseConfigured()) {
    return false;
  }

  if (!databaseReady) {
    await initDatabase();
    databaseReady = true;
  }

  return true;
}

/**
 * @param {string | number} chatId
 * @returns {Promise<boolean>} зарегистрирован ли этот chatId и активен ли он
 */
export async function isRegistered(chatId) {
  const key = getKey(chatId);

  if (await shouldUseDatabase()) {
    const result = await dbQuery(
      "SELECT is_active FROM bot_users WHERE telegram_id = $1;",
      [key]
    );

    return result.rows.length > 0 && result.rows[0].is_active === true;
  }

  return Boolean(store[key]?.isActive);
}

/**
 * Регистрирует chatId по верному коду. Повторная регистрация того же chatId
 * обновляет username, а не создаёт дублей и не сбрасывает is_active.
 * @param {string | number} chatId
 * @param {string | undefined} username
 * @returns {Promise<void>}
 */
export async function registerUser(chatId, username) {
  const key = getKey(chatId);
  const name = username ? String(username) : null;

  if (await shouldUseDatabase()) {
    await dbQuery(
      `
        INSERT INTO bot_users (telegram_id, username)
        VALUES ($1, $2)
        ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username;
      `,
      [key, name]
    );

    return;
  }

  store[key] = {
    username: name || "",
    role: store[key]?.role || "user",
    isActive: true,
    createdAt: store[key]?.createdAt || new Date().toISOString()
  };
  persistFile();
}

/**
 * Удаляет регистрацию. Нужен тестам для изоляции от чужих данных — так же,
 * как memory.clear()/clearProjects().
 * @param {string | number} chatId
 * @returns {Promise<void>}
 */
export async function removeUser(chatId) {
  const key = getKey(chatId);

  if (await shouldUseDatabase()) {
    await dbQuery("DELETE FROM bot_users WHERE telegram_id = $1;", [key]);
    return;
  }

  delete store[key];
  persistFile();
}
