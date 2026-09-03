import {
  discoverSpreadsheetFiles,
  extractSpreadsheetPaths,
  loadWorkbooks
} from "./reader.js";
import { formatWorkbookAnalytics } from "./analytics.js";
import {
  formatPurchaseOrderResult,
  preparePurchaseOrder
} from "./inventory.js";
import {
  formatSalesOrderResult,
  hasSalesOrderReport,
  prepareSalesOrder
} from "./salesOrder.js";
import { searchRows } from "./search.js";
import { runEdit } from "./editor.js";

const HELP_TEXT = [
  "Excel-модуль готов.",
  "",
  "Команды:",
  "/excel заказ остатки=data/ostatki.xlsx прайс=data/price.xlsx",
  "/excel замовлення data/t1.xlsx",
  "/excel аналитика data/ostatki.xlsx data/price.xlsx",
  "/excel поиск товар data/ostatki.xlsx",
  "",
  "Можно просто написать: Подготовь заказ поставщику.",
  "Или: Поменяй артикул A123 на B456 в data/ostatki.xlsx",
  "Файлы можно указать в сообщении, положить в data/ или сохранить в память агента."
].join("\n");

/**
 * @param {unknown} input
 * @returns {{ query: string, memories: string[] }}
 */
function normalizeInput(input) {
  if (typeof input === "string") {
    return {
      query: input,
      memories: []
    };
  }

  if (input && typeof input === "object") {
    const record = /** @type {Record<string, unknown>} */ (input);
    const rawQuery = record["query"];
    const rawMemories = record["memories"];

    return {
      query: typeof rawQuery === "string" ? rawQuery : String(rawQuery ?? ""),
      memories: Array.isArray(rawMemories)
        ? rawMemories.filter((value) => typeof value === "string")
        : []
    };
  }

  return {
    query: "",
    memories: []
  };
}

/**
 * @param {string} query
 * @returns {string}
 */
function removeExcelCommand(query) {
  return String(query || "")
    .replace(/^\/excel\b/i, "")
    .replace(/^\/purchase-order\b/i, "")
    .trim();
}

/**
 * @param {string} query
 * @param {string[]} memories
 * @returns {string[]}
 */
function collectFilesForReadOnlyMode(query, memories) {
  const files = [
    ...extractSpreadsheetPaths(query),
    ...extractSpreadsheetPaths(memories.join("\n"))
  ];

  return files.length > 0 ? [...new Set(files)] : discoverSpreadsheetFiles();
}

/**
 * @param {import("./search.js").SearchMatch[]} matches
 * @returns {string}
 */
function formatSearchMatches(matches) {
  if (matches.length === 0) {
    return "В таблицах ничего не найдено.";
  }

  return [
    `Найдено строк: ${matches.length}`,
    "",
    ...matches.map((match, index) => {
      const cells = Object.entries(match.row)
        .filter(([, value]) => String(value).trim())
        .slice(0, 8)
        .map(([key, value]) => `${key}: ${value}`)
        .join("; ");

      return `${index + 1}. ${match.source.file}, ${match.source.sheet}, строка ${match.source.rowNumber}\n${cells}`;
    })
  ].join("\n");
}

/**
 * @param {string} query
 * @returns {string}
 */
function extractSearchQuery(query) {
  return removeExcelCommand(query)
    .replace(/^(поиск|найди|найти|search)\b/i, "")
    .replace(/\S+\.(?:csv|xls|xlsx)\b/giu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} lower
 * @returns {boolean}
 */
function shouldPrepareSalesOrder(lower) {
  return (
    lower.includes("замовлення") ||
    lower.includes("заказ т1") ||
    lower.includes("заказ t1") ||
    lower.includes("замовлення т1") ||
    lower.includes("замовлення t1") ||
    lower.includes("заказ по отчету") ||
    lower.includes("заказ по отчёту") ||
    lower.includes("замовлення по звіту") ||
    lower.includes("отчет о розничных продажах") ||
    lower.includes("розничных продаж")
  );
}

/**
 * @param {string} lower
 * @returns {boolean}
 */
function shouldEditExcel(lower) {
  return (
    /измени|поменяй|исправь|обнови|замени/i.test(lower) &&
    /артикул|excel|csv|таблиц|файл|ячейк|штрихкод|sku/i.test(lower)
  );
}

/**
 * @param {string} query
 * @param {string[]} memories
 * @returns {boolean}
 */
function hasExplicitPurchaseOrderFiles(query, memories) {
  return /(?:остатк|stock|inventory|прайс|price|supplier|поставщик)\s*[:=]/i
    .test(`${query}\n${memories.join("\n")}`);
}

/**
 * @param {unknown} input
 * @returns {Promise<string>}
 */
export async function runExcelTool(input) {
  const request = normalizeInput(input);
  const query = removeExcelCommand(request.query);
  const lower = query.toLowerCase();

  if (!query || lower === "help" || lower === "помощь") {
    return HELP_TEXT;
  }

  if (shouldEditExcel(lower)) {
    return await runEdit({
      query,
      memories: request.memories
    });
  }

  if (shouldPrepareSalesOrder(lower)) {
    const result = await prepareSalesOrder({
      query,
      memories: request.memories
    });

    return formatSalesOrderResult(result);
  }

  if (
    lower.includes("аналит") ||
    lower.includes("отчет") ||
    lower.includes("отчёт") ||
    lower.includes("summary")
  ) {
    const files = collectFilesForReadOnlyMode(query, request.memories);

    if (files.length === 0) {
      return "Не нашёл Excel/CSV-файлы для аналитики. Укажи путь к файлу или положи таблицы в data/.";
    }

    return formatWorkbookAnalytics(loadWorkbooks(files));
  }

  if (
    lower.startsWith("поиск") ||
    lower.startsWith("найди") ||
    lower.startsWith("найти") ||
    lower.startsWith("search")
  ) {
    const files = collectFilesForReadOnlyMode(query, request.memories);
    const searchQuery = extractSearchQuery(query);

    if (!searchQuery) {
      return "Напиши, что искать в таблицах. Например: /excel поиск шампунь data/ostatki.xlsx";
    }

    if (files.length === 0) {
      return "Не нашёл Excel/CSV-файлы для поиска. Укажи путь к файлу или положи таблицы в data/.";
    }

    return formatSearchMatches(
      searchRows(loadWorkbooks(files), searchQuery)
    );
  }

  if (
    !hasExplicitPurchaseOrderFiles(query, request.memories) &&
    hasSalesOrderReport({
      query,
      memories: request.memories
    })
  ) {
    const result = await prepareSalesOrder({
      query,
      memories: request.memories
    });

    return formatSalesOrderResult(result);
  }

  const result = await preparePurchaseOrder({
    query,
    memories: request.memories
  });

  return formatPurchaseOrderResult(result);
}

export default {
  run: runExcelTool
};