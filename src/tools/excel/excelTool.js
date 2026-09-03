import {
  discoverSpreadsheetFiles,
  existsInProject,
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
import {
  analyzeDeadStock,
  formatDeadStockResult
} from "./deadStock.js";
import {
  filterRowsByName,
  formatFilterResult
} from "./filterByName.js";
import {
  buildTransferDoc,
  formatTransferResult,
  looksLikeTransferFile
} from "./transferDoc.js";
import {
  buildRedistribution,
  formatRedistributeResult
} from "./redistribute.js";
import {
  buildCriteriaTransfer,
  formatCriteriaTransferResult
} from "./transferByCriteria.js";
import { searchRows } from "./search.js";
import { runEdit } from "./editor.js";

const HELP_TEXT = [
  "Excel-модуль готов.",
  "",
  "Команды:",
  "/excel заказ остатки=data/ostatki.xlsx прайс=data/price.xlsx",
  "/excel замовлення data/t1.xlsx",
  "/excel непроданное data/t1.xlsx data/t2.xlsx data/x1.xlsx",
  "/excel перемещение по нулевым продажам data/t1.xlsx data/t2.xlsx",
  "/excel перенеси с Т5 где реализация<20%",
  "/excel оставь только pjur data/t1.xlsx",
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
    ...new Set([
      ...extractSpreadsheetPaths(query),
      ...extractSpreadsheetPaths(memories.join("\n"))
    ])
  ].filter(existsInProject);

  return files.length > 0 ? files : discoverSpreadsheetFiles();
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
 * «Перенос по критериям»: «перенеси с Т5 где реализация<20%». Отличается от
 * shouldRedistribute наличием явного условия со сравнением, поэтому проверяется
 * раньше. Знак «=» намеренно не считается условием: «замовлення реализация=40»
 * — это переопределение порога заказа, а не перенос.
 * @param {string} lower
 * @returns {boolean}
 */
function shouldMoveByCriteria(lower) {
  const hasCondition =
    /(?:реализац|реалізац|продаж|продал|остат|залиш|запас|дней|днів|sell)[\p{L}]*\s*(?:<=|>=|<|>|меньше|менее|менше|больше|более|більше)\s*\d/u
      .test(lower);
  const hasMoveVerb = /перенес|перенес[тьи]|вывез|вывоз|перекид/i.test(lower);

  return hasCondition && (hasMoveVerb || !/замовлення|заказ/i.test(lower));
}

/**
 * «Перемещение по нулевым продажам»: из отчётов продаж посчитать, что вывезти
 * со складов, где товар не продаётся, туда, где продаётся. Проверять ДО
 * shouldBuildTransfer — фраза «перемещение ... продаж 0» подходит обоим.
 * @param {string} lower
 * @returns {boolean}
 */
function shouldRedistribute(lower) {
  return (
    /перераспредел/i.test(lower) ||
    /развез|разброса|раскида/i.test(lower) ||
    (
      /перем[іие]щ|перекин|перенос/i.test(lower) &&
      /продаж|нулев|нол[ья]|непродающ|м[её]ртв|неликвид|\b0\b/i.test(lower)
    )
  );
}

/**
 * «Документ перемещения»: список артикулов по листам-магазинам → плоская
 * таблица «Со склада / На склад / Артикул / Название / Кол-во / Примечание».
 * @param {string} lower
 * @returns {boolean}
 */
function shouldBuildTransfer(lower) {
  return (
    /перем[іие]щ/i.test(lower) ||
    /перекин/i.test(lower) ||
    lower.includes("документ перемещения")
  );
}

/**
 * «Оставь только <текст>» / «удали всё кроме <текст>»: вырезать из файла все
 * строки, кроме тех, где в названии есть заданная подстрока.
 * @param {string} lower
 * @returns {boolean}
 */
function shouldFilterByName(lower) {
  // Без \b после кириллицы: в JS \b работает только по ASCII-словам.
  return (
    /остав(?:ь|ить|и)\s+(?:тольк[ои]|лишь)/i.test(lower) ||
    /удали(?:ть)?\s+(?:вс[её]|все)\s+кроме/i.test(lower) ||
    /залиши(?:ти)?\s+тільки/i.test(lower) ||
    /видали(?:ти)?\s+вс[еі]\s+кр[іи]м/i.test(lower) ||
    /keep\s+only/i.test(lower)
  );
}

/**
 * «Непроданное» / неликвид: собрать товары без розничных и оптовых продаж
 * за период из нескольких файлов в один Excel.
 * @param {string} lower
 * @returns {boolean}
 */
function shouldReportDeadStock(lower) {
  return (
    /непродан|не\s+продал|нераспродан|неликвид|залежал|мертв\w*\s+товар|dead\s*stock/i
      .test(lower) ||
    lower.includes("что не продалось") ||
    lower.includes("не продавалось")
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

  if (shouldMoveByCriteria(lower)) {
    const result = await buildCriteriaTransfer({
      query,
      memories: request.memories
    });

    return formatCriteriaTransferResult(result);
  }

  if (shouldRedistribute(lower)) {
    const result = await buildRedistribution({
      query,
      memories: request.memories
    });

    return formatRedistributeResult(result);
  }

  if (shouldBuildTransfer(lower)) {
    const result = await buildTransferDoc({
      query,
      memories: request.memories
    });

    return formatTransferResult(result);
  }

  if (shouldFilterByName(lower)) {
    const result = await filterRowsByName({
      query,
      memories: request.memories
    });

    return formatFilterResult(result);
  }

  if (shouldReportDeadStock(lower)) {
    const result = await analyzeDeadStock({
      query,
      memories: request.memories
    });

    return formatDeadStockResult(result);
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

  // Под "заказ поставщику" подсунули список перемещения: колонки остатка в нём
  // нет и не будет. Вместо тупикового отказа собираем то, чем файл является.
  if (result.reason === "not_stock_file") {
    const transferFiles = result.stockFiles.filter(looksLikeTransferFile);

    if (transferFiles.length > 0) {
      const transfer = await buildTransferDoc({
        query,
        memories: request.memories,
        files: transferFiles
      });

      if (transfer.status === "success") {
        return [
          "Это список перемещения, а не остатки — заказ поставщику по нему не собрать.",
          "Собрал документ перемещения:",
          "",
          formatTransferResult(transfer)
        ].join("\n");
      }
    }
  }

  return formatPurchaseOrderResult(result);
}

export default {
  run: runExcelTool
};