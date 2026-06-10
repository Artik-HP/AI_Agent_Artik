import fs from "node:fs";

const MEMORY_FILE = "memory.json";

let store = load();
// store — объект всей памяти

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
function persist() {
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
 * @param {string} text
 * @param {string | number} chatId
 * @returns {boolean}
 */
export function save(text, chatId = "default") {
  const key = getKey(chatId);

  if (!store[key]) {
    store[key] = [];
  }

  store[key].push(text);
  persist();

  return true;
}

/**
 * @param {string | number} chatId
 * @returns {string[]}
 */
export function getAll(chatId = "default") {
  const key = getKey(chatId);

  return [...(store[key] || [])];
}

/**
 * @param {string | number} chatId
 * @returns {boolean}
 */
export function clear(chatId = "default") {
  const key = getKey(chatId);

  store[key] = [];
  persist();

  return true;
}

/**
 * @param {number} index
 * @param {string | number} chatId
 * @returns {boolean}
 */
export function remove(index, chatId = "default") {
  const key = getKey(chatId);
  const memories = store[key] || [];

  if (index < 0 || index >= memories.length) {
    return false;
  }

  memories.splice(index, 1);
  store[key] = memories;
  persist();

  return true;
}

/**
 * @param {string} text
 * @param {string | number} chatId
 * @returns {boolean}
 */
export function removeByText(text, chatId = "default") {
  const key = getKey(chatId);
  const memories = store[key] || [];

  const normalizedText = String(text || "").trim().toLowerCase();

  if (!normalizedText) {
    return false;
  }

  const index = memories.findIndex(
    (item) => String(item).trim().toLowerCase() === normalizedText
  );

  if (index === -1) {
    return false;
  }

  memories.splice(index, 1);
  store[key] = memories;
  persist();

  return true;
}