import fs from "node:fs";

import {
    initDatabase,
    isDatabaseConfigured,
    dbQuery
} from "./database.js";
/**
 * @typedef {Object<string, string[]>} MemoryStore
 */

/**
 * @typedef {Object} MemoryRow
 * @property {string} content
 */

/**
 * @typedef {Object} QueryResult
 * @property {MemoryRow[]} rows
 * @property {number} rowCount
 */

/**
 * @typedef {string | number} ChatId
 */

/**
 * @typedef {Object} DatabaseMemoryRow
 * @property {string} content
 * @property {string} [created_at]
 * @property {number} [id]
 */

/**
 * @typedef {Object} QueryOptions
 * @property {string} sql
 * @property {(string | number)[]} params
 */

/**
 * @typedef {Object} MemoryOptions
 * @property {string} [filePath]
 */

const MEMORY_FILE = "memory.json";

/** @type {MemoryStore} */
let store = load();
/** @type {boolean} */
let databaseReady = false;

/**
 * @returns {Object<string, string[]>}
 */
function load() {
  if (!fs.existsSync(MEMORY_FILE)) {
    return {};
  }

  const raw = fs.readFileSync(MEMORY_FILE, "utf8");

  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

/**
 * @returns {void}
 */
function persistFile() {
  fs.writeFileSync(
    MEMORY_FILE,
    JSON.stringify(store, null, 2),
    "utf8"
  );
}

/**
 * @param {string | number} chatId
 * @returns {string}
 */
function getKey(chatId = "default") {
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
 * @param {string} text
 * @param {string | number} chatId
 * @returns {Promise<boolean>}
 */
export async function save(text, chatId = "default") {
  if (await shouldUseDatabase()) {
await dbQuery(      "INSERT INTO memories (chat_id, content) VALUES ($1, $2);",
      [getKey(chatId), text]
    );

    return true;
  }

  const key = getKey(chatId);

  if (!store[key]) {
    store[key] = [];
  }

  store[key].push(text);
  persistFile();

  return true;
}

/**
 * @param {string | number} chatId
 * @returns {Promise<string[]>}
 */
export async function getAll(chatId = "default") {
  if (await shouldUseDatabase()) {
const result = await dbQuery(      `
        SELECT content
        FROM memories
        WHERE chat_id = $1
        ORDER BY created_at ASC, id ASC;
      `,
      [getKey(chatId)]
    );

    return result.rows.map((row) => String(/** @type {{ content?: unknown }} */(row)?.content || ""));
  }

  const key = getKey(chatId);

  return [...(store[key] || [])];
}

/**
 * @param {string | number} chatId
 * @returns {Promise<boolean>}
 */
export async function clear(chatId = "default") {
  if (await shouldUseDatabase()) {
await dbQuery(      "DELETE FROM memories WHERE chat_id = $1;",
      [getKey(chatId)]
    );

    return true;
  }

  const key = getKey(chatId);

  store[key] = [];
  persistFile();

  return true;
}

/**
 * @param {number} index
 * @param {string | number} chatId
 * @returns {Promise<boolean>}
 */
export async function remove(index, chatId = "default") {
  if (index < 0) {
    return false;
  }

  if (await shouldUseDatabase()) {
    const result = await dbQuery(
      `
        WITH target AS (
          SELECT id
          FROM memories
          WHERE chat_id = $1
          ORDER BY created_at ASC, id ASC
          OFFSET $2
          LIMIT 1
        )
        DELETE FROM memories
        USING target
        WHERE memories.id = target.id
        RETURNING memories.id;
      `,
      [getKey(chatId), index]
    );

    return (result.rowCount ?? 0) > 0;
  }

  const key = getKey(chatId);
  const memories = store[key] || [];

  if (index >= memories.length) {
    return false;
  }

  memories.splice(index, 1);
  store[key] = memories;
  persistFile();

  return true;
}

/**
 * @param {string} text
 * @param {string | number} chatId
 * @returns {Promise<boolean>}
 */
export async function removeByText(text, chatId = "default") {
  const normalizedText = String(text || "").trim().toLowerCase();

  if (!normalizedText) {
    return false;
  }

  if (await shouldUseDatabase()) {
    const result = await dbQuery(
      `
        WITH target AS (
          SELECT id
          FROM memories
          WHERE chat_id = $1
            AND LOWER(TRIM(content)) = $2
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        )
        DELETE FROM memories
        USING target
        WHERE memories.id = target.id
        RETURNING memories.id;
      `,
      [getKey(chatId), normalizedText]
    );

    return (result.rowCount ?? 0) > 0;
  }

  const key = getKey(chatId);
  const memories = store[key] || [];

  const index = memories.findIndex(
    item => String(item).trim().toLowerCase() === normalizedText
  );

  if (index === -1) {
    return false;
  }

  memories.splice(index, 1);
  store[key] = memories;
  persistFile();

  return true;
}
