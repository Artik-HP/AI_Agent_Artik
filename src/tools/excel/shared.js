import path from "node:path";

import {
  discoverSpreadsheetFiles,
  existsInProject,
  extractSpreadsheetPaths,
  sortByRecency
} from "./reader.js";
import { normalizePointCode } from "./points.js";
import { dataPath } from "../../utils/dataDir.js";

/**
 * Каталог, куда складываются все сформированные ботом книги — уже
 * абсолютный путь на DATA_DIR. Модули, которые оборачивают его в
 * path.resolve(process.cwd(), OUTPUT_DIR) (salesOrder.js, writer.js,
 * transferBuilder.js, sheets.js), менять не пришлось: path.resolve
 * останавливается на первом абсолютном аргументе справа, так что
 * process.cwd() там уже ни на что не влияет.
 */
export const OUTPUT_DIR = dataPath("exports");

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

  // Имена, под которыми бот сохраняет свои книги в exports/ — все латиницей,
  // см. fileName в вызовах writeReportWorkbook. Список важен для замовлення:
  // оно добирает выгрузки чата под лист «Переміщення», и вернувшийся в чат
  // отчёт бота выглядел бы там ещё одним магазином.
  //
  // Кириллических слов здесь намеренно нет. «Замовлення» и «заказ» стояли тут
  // с тех пор, когда список жил в salesOrder.js, и отсекали живые выгрузки:
  // человек называет свои файлы «замовлення 22.07 Т3 (4.07-21.07.2026).xlsx»,
  // и бот их молча не видел.
  const generatedMarkers = [
    "sales-order",
    "purchase-order",
    "neprodano",
    "perenos-po-kriteriyam",
    "peremeshchenie",
    "razvezti",
    "filter-",
    "sheets-",
    "analiz-"
  ];

  return generatedMarkers.some(marker => fileName.includes(marker));
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
 * @typedef {Object} FreshRecords
 * @property {import("./deadStock.js").DeadStockRecord[]} records что осталось
 * @property {{ point: string, kept: string, dropped: string[] }[]} skipped
 */

/**
 * Оставляет по каждой торговой точке только самую свежую выгрузку.
 *
 * Пул копится месяцами, и одна и та же Т1 лежит сразу в нескольких файлах:
 * «Т1 01.08-05.09», «Всі магазини 01.08-05.09», «Книга перемещения». Раньше
 * движение по ней складывалось столько раз, сколько файлов её содержали —
 * продажи утраивались, а вместе с ними и «сколько довезти». Снимки остатка
 * при этом брались максимальные, так что ошибка была односторонней: бот
 * возил больше, чем нужно.
 *
 * Свежесть — по времени изменения файла, а не по порядку в списке: пути
 * приходят вперемешку из запроса, памяти и автопоиска.
 * @param {import("./deadStock.js").DeadStockRecord[]} records
 * @param {string[]} files пути, из которых эти записи прочитаны
 * @returns {FreshRecords}
 */
export function keepFreshestPointRecords(records, files) {
  const order = sortByRecency(files);
  /** @type {Map<string, number>} */
  const rankByName = new Map(
    order.map((filePath, index) => [
      String(filePath).split(/[\\/]/).pop() || String(filePath),
      index
    ])
  );
  /** @type {Map<string, { rank: number, file: string }>} */
  const bestByPoint = new Map();

  const pointKey = record =>
    normalizePointCode(record.point) || String(record.point || "").trim();

  for (const record of records) {
    const key = pointKey(record);
    const rank = rankByName.has(record.file)
      ? Number(rankByName.get(record.file))
      : Number.MAX_SAFE_INTEGER;
    const best = bestByPoint.get(key);

    if (!best || rank < best.rank) {
      bestByPoint.set(key, { rank, file: record.file });
    }
  }

  /** @type {Map<string, Set<string>>} */
  const droppedByPoint = new Map();
  const kept = records.filter(record => {
    const key = pointKey(record);
    const best = bestByPoint.get(key);

    if (best && record.file === best.file) {
      return true;
    }

    if (!droppedByPoint.has(key)) {
      droppedByPoint.set(key, new Set());
    }

    droppedByPoint.get(key)?.add(record.file);

    return false;
  });

  return {
    records: kept,
    skipped: [...droppedByPoint].map(([point, files_]) => ({
      point,
      kept: bestByPoint.get(point)?.file || "",
      dropped: [...files_]
    }))
  };
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
