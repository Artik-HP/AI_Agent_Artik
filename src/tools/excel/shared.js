import path from "node:path";

import {
  discoverSpreadsheetFiles,
  existsInProject,
  extractSpreadsheetPaths
} from "./reader.js";

/** Каталог, куда складываются все сформированные ботом книги. */
export const OUTPUT_DIR = "exports";

/** Корень пользовательских загрузок: внутри — по каталогу на каждый чат. */
const TELEGRAM_DIR = "data/telegram";

/** Общие таблицы проекта, не привязанные к чату. */
const SHARED_DATA_DIR = "data";

/**
 * Единый вход всех Excel-операций. Раньше эта структура была продублирована
 * в каждом модуле-отчёте и успела разойтись в трёх местах, поэтому контракт
 * держим здесь одним экземпляром.
 * @typedef {Object} ExcelRequest
 * @property {string} query текст запроса пользователя
 * @property {string[]} memories память агента — там лежат пути загруженных файлов
 * @property {string[]} files явные пути, в обход разбора текста
 * @property {string|null} outDir каталог результата, null — OUTPUT_DIR
 * @property {string|null} chatId чей это чат; его загрузки и считаем своими
 */

/**
 * @param {Date} [date]
 * @returns {string}
 */
export function createTimestamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
}

/**
 * @param {unknown} input
 * @returns {ExcelRequest}
 */
export function normalizeInput(input) {
  if (typeof input === "string") {
    return { query: input, memories: [], files: [], outDir: null, chatId: null };
  }

  if (input && typeof input === "object") {
    const record = /** @type {Record<string, unknown>} */ (input);

    return {
      query: String(record.query || ""),
      memories: Array.isArray(record.memories) ? record.memories.map(String) : [],
      files: Array.isArray(record.files) ? record.files.map(String) : [],
      outDir: record.outDir ? String(record.outDir) : null,
      chatId: record.chatId ? String(record.chatId) : null
    };
  }

  return { query: "", memories: [], files: [], outDir: null, chatId: null };
}

/**
 * Книга, которую сформировал сам бот, а пользователь переслал её обратно
 * в Telegram. Такой файл выглядит как обычная выгрузка, парсер читает его без
 * ошибки и выдаёт «точку», названную по имени файла, — то есть подмешивает
 * в расчёт несуществующий магазин.
 *
 * Отсекаем только неявные источники: то, что названо в запросе явно, остаётся.
 * @param {string} filePath
 * @returns {boolean}
 */
export function looksLikeGeneratedReport(filePath) {
  const fileName = path.basename(String(filePath || "")).toLowerCase();

  // Замовлення поставщику — исторический список, был в salesOrder.js.
  const orderMarkers = [
    "замовлення",
    "заказ",
    "order",
    "purchase"
  ];

  // TODO(human): дополнить признаками остальных выходных книг бота

  return orderMarkers.some(marker => fileName.includes(marker));
}

/**
 * Каталоги автопоиска для конкретного чата. Свои загрузки — в приоритете;
 * общие таблицы проекта идут следом, но БЕЗ data/telegram, иначе в выборку
 * попадут файлы чужих чатов.
 * @param {string|null} [chatId]
 * @returns {string[]}
 */
export function discoverChatFiles(chatId = null) {
  const own = chatId
    ? discoverSpreadsheetFiles(`${TELEGRAM_DIR}/${chatId}`)
    : [];

  if (own.length > 0) {
    return own;
  }

  return discoverSpreadsheetFiles(SHARED_DATA_DIR, {
    skipDirs: [TELEGRAM_DIR]
  });
}

/**
 * Порядок источников: явные пути → пути из запроса и памяти → автопоиск.
 * Память копится вечно и хранит в том числе книги, которые бот сам же и
 * сделал, поэтому её вклад фильтруем; путь, написанный в запросе руками, —
 * нет: раз назвали явно, значит так и хотели.
 * @param {{ query: string, memories: string[], files: string[], chatId?: string|null }} request
 * @returns {string[]}
 */
export function resolveFiles(request) {
  if (request.files.length > 0) {
    return [...new Set(request.files)].filter(existsInProject);
  }

  const fromQuery = extractSpreadsheetPaths(request.query);
  const fromMemory = extractSpreadsheetPaths(request.memories.join("\n"))
    .filter(file => !looksLikeGeneratedReport(file));
  const named = [...new Set([...fromQuery, ...fromMemory])].filter(existsInProject);

  if (named.length > 0) {
    return named;
  }

  return discoverChatFiles(request.chatId ?? null)
    .filter(file => !looksLikeGeneratedReport(file));
}
