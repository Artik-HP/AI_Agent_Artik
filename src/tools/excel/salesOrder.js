import fs from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";
import xlsx from "xlsx";

import {
  discoverSpreadsheetFiles,
  extractSpreadsheetPaths,
  resolveProjectPath,
  toProjectPath
} from "./reader.js";
import { parseNumber } from "./search.js";

const OUTPUT_DIR = "exports";
const DEFAULT_MAX_STOCK_DAYS = 45;
const DEFAULT_TARGET_PERIODS = 2;
const DEFAULT_SKU_PREFIXES = [
  "SO",
  "SX",
  "AD",
  "PJ"
];

const COLUMN_INDEX = {
  sku: 0,
  name: 1,
  start: 2,
  receipt: 3,
  available: 5,
  expense: 6,
  retailSales: 7,
  buyerSales: 8,
  end: 9,
  turnover: 10,
  stockDays: 11,
  sellThrough: 12
};

const FILL_COLORS = {
  available: "FFBDD7EE",
  retailSales: "FFC5E0B4",
  end: "FFD9D9D9",
  order: "FFFBE5D6"
};

/**
 * @typedef {Object} SalesOrderLine
 * @property {number} sourceRow
 * @property {string} sku
 * @property {string} name
 * @property {number|null} start
 * @property {number|null} receipt
 * @property {number|null} available
 * @property {number|null} expense
 * @property {number|null} retailSales
 * @property {number|null} buyerSales
 * @property {number|null} end
 * @property {number|null} turnover
 * @property {number|null} stockDays
 * @property {number|null} sellThrough
 * @property {number} recommendedOrder
 */

/**
 * @typedef {Object} SalesOrderOptions
 * @property {number} maxStockDays
 * @property {number} targetPeriods
 * @property {string[]} skuPrefixes
 */

/**
 * @typedef {Object} SalesOrderResult
 * @property {"success"|"needs_file"|"empty"} status
 * @property {string|null} sourceFile
 * @property {string|null} outputPath
 * @property {SalesOrderOptions} options
 * @property {SalesOrderLine[]} lines
 * @property {{ lines: number, recommendedTotal: number }} summary
 * @property {string[]} notes
 */

/**
 * @param {Date} [date]
 * @returns {string}
 */
function createTimestamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
  return [...new Set(values.map(value => String(value || "").trim()))]
    .filter(Boolean);
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
  return parseNumber(value);
}

/**
 * @param {unknown} value
 * @returns {number|string}
 */
function valueOrEmpty(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : "";
}

/**
 * @param {string} query
 * @returns {number}
 */
function extractMaxStockDays(query) {
  const match = query.match(
    /(?:days|max_days|дней|дн(?:ів|ей)?|дни|днів)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i
  );

  return match
    ? toNumber(match[1]) || DEFAULT_MAX_STOCK_DAYS
    : DEFAULT_MAX_STOCK_DAYS;
}

/**
 * @param {string} query
 * @returns {number}
 */
function extractTargetPeriods(query) {
  const match = query.match(
    /(?:periods?|target|коэф|коеф|множитель|период(?:ов|а)?)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i
  );

  return match
    ? toNumber(match[1]) || DEFAULT_TARGET_PERIODS
    : DEFAULT_TARGET_PERIODS;
}

/**
 * @param {string} query
 * @returns {string[]}
 */
function extractSkuPrefixes(query) {
  const match = query.match(
    /(?:prefixes?|префиксы|префикс)\s*[:=]\s*([a-zа-я0-9,\s]+)/i
  );

  if (!match) {
    return DEFAULT_SKU_PREFIXES;
  }

  const prefixes = match[1]
    .split(/[\s,]+/)
    .map(prefix => prefix.trim().toUpperCase())
    .filter(Boolean);

  return prefixes.length > 0 ? prefixes : DEFAULT_SKU_PREFIXES;
}

/**
 * @param {string} query
 * @returns {SalesOrderOptions}
 */
function parseOptions(query) {
  return {
    maxStockDays: extractMaxStockDays(query),
    targetPeriods: extractTargetPeriods(query),
    skuPrefixes: extractSkuPrefixes(query)
  };
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function looksLikeOutputFile(filePath) {
  const fileName = path.basename(filePath).toLowerCase();

  return (
    fileName.includes("замовлення") ||
    fileName.includes("заказ") ||
    fileName.includes("order") ||
    fileName.includes("purchase")
  );
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isLikelyMovementReport(filePath) {
  try {
    const workbook = xlsx.readFile(resolveProjectPath(filePath));
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      raw: false,
      blankrows: false
    });
    const headerText = rows
      .slice(0, 3)
      .flat()
      .join(" ")
      .toLowerCase();

    return (
      headerText.includes("отчет о розничных продажах") ||
      headerText.includes("звіт") ||
      headerText.includes("розничных продаж")
    );
  } catch {
    return false;
  }
}

/**
 * @param {string} query
 * @param {string[]} memories
 * @returns {string|null}
 */
function findReportFile(query, memories) {
  const files = unique([
    ...extractSpreadsheetPaths(query),
    ...extractSpreadsheetPaths(memories.join("\n"))
  ]);

  if (files.length > 0) {
    return files.find(file => !looksLikeOutputFile(file)) || files[0];
  }

  const discovered = discoverSpreadsheetFiles()
    .filter(file => !looksLikeOutputFile(file));

  return discovered.find(isLikelyMovementReport) || discovered[0] || null;
}

/**
 * @param {unknown} input
 * @returns {boolean}
 */
export function hasSalesOrderReport(input) {
  const request = normalizeInput(input);
  const sourceFile = findReportFile(
    request.query,
    request.memories
  );

  return Boolean(sourceFile && isLikelyMovementReport(sourceFile));
}

/**
 * @param {unknown[]} row
 * @returns {boolean}
 */
function isProductRow(row) {
  const sku = String(row[COLUMN_INDEX.sku] || "").trim();
  const name = String(row[COLUMN_INDEX.name] || "").trim();

  return Boolean(
    sku &&
    name &&
    sku !== "Номенклатура.Артикул" &&
    !sku.toLowerCase().includes("toppers")
  );
}

/**
 * @param {string} sku
 * @param {string[]} prefixes
 * @returns {number}
 */
function getPrefixRank(sku, prefixes) {
  const normalizedSku = sku.toUpperCase();
  const rank = prefixes.findIndex(prefix =>
    normalizedSku.startsWith(prefix)
  );

  return rank === -1 ? prefixes.length : rank;
}

/**
 * @param {string} sku
 * @param {string[]} prefixes
 * @returns {boolean}
 */
function hasAllowedPrefix(sku, prefixes) {
  const normalizedSku = sku.toUpperCase();

  return prefixes.some(prefix =>
    normalizedSku.startsWith(prefix)
  );
}

/**
 * @param {unknown[]} row
 * @param {number} sourceRow
 * @param {SalesOrderOptions} options
 * @returns {SalesOrderLine|null}
 */
function createSalesOrderLine(row, sourceRow, options) {
  if (!isProductRow(row)) {
    return null;
  }

  const sku = String(row[COLUMN_INDEX.sku]).trim();

  if (!hasAllowedPrefix(sku, options.skuPrefixes)) {
    return null;
  }

  const expense = toNumber(row[COLUMN_INDEX.expense]) || 0;
  const stockDays = toNumber(row[COLUMN_INDEX.stockDays]) || 0;

  if (
    expense <= 0 ||
    stockDays <= 0 ||
    stockDays > options.maxStockDays
  ) {
    return null;
  }

  const end = toNumber(row[COLUMN_INDEX.end]) || 0;
  const recommendedOrder = Math.max(
    0,
    Math.ceil(expense * options.targetPeriods - end)
  );

  return {
    sourceRow,
    sku,
    name: String(row[COLUMN_INDEX.name] || "").trim(),
    start: toNumber(row[COLUMN_INDEX.start]),
    receipt: toNumber(row[COLUMN_INDEX.receipt]),
    available: toNumber(row[COLUMN_INDEX.available]),
    expense,
    retailSales: toNumber(row[COLUMN_INDEX.retailSales]),
    buyerSales: toNumber(row[COLUMN_INDEX.buyerSales]),
    end: toNumber(row[COLUMN_INDEX.end]),
    turnover: toNumber(row[COLUMN_INDEX.turnover]),
    stockDays,
    sellThrough: toNumber(row[COLUMN_INDEX.sellThrough]),
    recommendedOrder
  };
}

/**
 * @param {string} filePath
 * @param {SalesOrderOptions} options
 * @returns {SalesOrderLine[]}
 */
function readSalesOrderLines(filePath, options) {
  const fullPath = resolveProjectPath(filePath);
  const workbook = xlsx.readFile(fullPath, {
    cellDates: true
  });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: "",
    raw: true,
    blankrows: false
  });

  return rows
    .map((row, index) =>
      createSalesOrderLine(row, index + 1, options)
    )
    .filter(Boolean)
    .sort((first, second) => {
      const rankDiff =
        getPrefixRank(first.sku, options.skuPrefixes) -
        getPrefixRank(second.sku, options.skuPrefixes);

      if (rankDiff !== 0) {
        return rankDiff;
      }

      return first.sourceRow - second.sourceRow;
    });
}

/**
 * @param {ExcelJS.Worksheet} worksheet
 * @param {number} columnNumber
 * @param {string} color
 * @returns {void}
 */
function fillColumn(worksheet, columnNumber, color) {
  worksheet.getColumn(columnNumber).eachCell(cell => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: {
        argb: color
      }
    };
  });
}

/**
 * @param {ExcelJS.Worksheet} worksheet
 * @returns {void}
 */
function styleWorksheet(worksheet) {
  worksheet.views = [
    {
      state: "frozen",
      ySplit: 1
    }
  ];
  worksheet.autoFilter = {
    from: "A1",
    to: "M1"
  };

  fillColumn(worksheet, 5, FILL_COLORS.available);
  fillColumn(worksheet, 7, FILL_COLORS.retailSales);
  fillColumn(worksheet, 9, FILL_COLORS.end);
  fillColumn(worksheet, 13, FILL_COLORS.order);

  worksheet.getRow(1).font = {
    bold: true
  };

  for (const column of [3, 4, 5, 6, 7, 8, 9]) {
    worksheet.getColumn(column).numFmt = "0.000";
  }

  worksheet.getColumn(10).numFmt = "#,##0.00";
  worksheet.getColumn(11).numFmt = "#,##0.0";
  worksheet.getColumn(12).numFmt = "0%";
  worksheet.getColumn(13).numFmt = "#,##0";

  worksheet.eachRow(row => {
    row.eachCell(cell => {
      cell.alignment = {
        vertical: "top",
        wrapText: false
      };
      cell.border = {
        bottom: {
          style: "thin",
          color: {
            argb: "FFE5E7EB"
          }
        }
      };
    });
  });
}

/**
 * @param {SalesOrderResult} result
 * @returns {Promise<string>}
 */
async function writeSalesOrderWorkbook(result) {
  const outputDir = path.resolve(process.cwd(), OUTPUT_DIR);
  const filePath = path.join(
    outputDir,
    `sales-order-t1-${createTimestamp()}.xlsx`
  );
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Замовлення");

  fs.mkdirSync(outputDir, {
    recursive: true
  });

  workbook.creator = "AI_Agent_Artik";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.calcProperties.forceFullCalc = true;

  worksheet.columns = [
    { header: "Місце зберігання", key: "sku", width: 16 },
    { header: "", key: "name", width: 72 },
    { header: "Начало", key: "start", width: 11 },
    { header: "Приход", key: "receipt", width: 11 },
    { header: "", key: "available", width: 11 },
    { header: "Расход", key: "expense", width: 11 },
    { header: "Отчет о розничных продажах", key: "retailSales", width: 14 },
    { header: "Продажа покупателю", key: "buyerSales", width: 14 },
    { header: "Конец", key: "end", width: 11 },
    { header: "", key: "turnover", width: 10 },
    { header: "", key: "stockDays", width: 10 },
    { header: "", key: "sellThrough", width: 10 },
    { header: "Заказ", key: "orderQuantity", width: 10 }
  ];

  for (const line of result.lines) {
    const row = worksheet.addRow({
      sku: line.sku,
      name: line.name,
      start: valueOrEmpty(line.start),
      receipt: valueOrEmpty(line.receipt),
      available: valueOrEmpty(line.available),
      expense: valueOrEmpty(line.expense),
      retailSales: valueOrEmpty(line.retailSales),
      buyerSales: valueOrEmpty(line.buyerSales),
      end: valueOrEmpty(line.end),
      turnover: valueOrEmpty(line.turnover),
      stockDays: valueOrEmpty(line.stockDays),
      sellThrough: valueOrEmpty(line.sellThrough)
    });
    const rowNumber = row.number;
    const orderFormula = [
      "IF(",
      `MAX(0,ROUNDUP(F${rowNumber}*${result.options.targetPeriods}-I${rowNumber},0))=0,`,
      "\"\",",
      `MAX(0,ROUNDUP(F${rowNumber}*${result.options.targetPeriods}-I${rowNumber},0))`,
      ")"
    ].join("");

    row.getCell("orderQuantity").value = {
      formula: orderFormula,
      result: line.recommendedOrder || ""
    };
  }

  styleWorksheet(worksheet);

  await workbook.xlsx.writeFile(filePath);

  return filePath;
}

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
    return {
      query: String(input.query || ""),
      memories: Array.isArray(input.memories) ? input.memories : []
    };
  }

  return {
    query: "",
    memories: []
  };
}

/**
 * @param {unknown} input
 * @returns {Promise<SalesOrderResult>}
 */
export async function prepareSalesOrder(input) {
  const request = normalizeInput(input);
  const options = parseOptions(request.query);
  const sourceFile = findReportFile(request.query, request.memories);

  if (!sourceFile) {
    return {
      status: "needs_file",
      sourceFile: null,
      outputPath: null,
      options,
      lines: [],
      summary: {
        lines: 0,
        recommendedTotal: 0
      },
      notes: [
        "Не нашёл Excel-файл отчёта Т1.",
        "Укажи файл в команде или отправь отчёт боту в Telegram.",
        "Пример: /excel замовлення data/t1.xlsx"
      ]
    };
  }

  const lines = readSalesOrderLines(sourceFile, options);
  const result = {
    status: lines.length > 0 ? "success" : "empty",
    sourceFile,
    outputPath: null,
    options,
    lines,
    summary: {
      lines: lines.length,
      recommendedTotal: lines.reduce(
        (sum, line) => sum + line.recommendedOrder,
        0
      )
    },
    notes: []
  };

  if (lines.length === 0) {
    result.notes.push(
      "В отчёте нет строк под фильтр замовлення Т1."
    );

    return result;
  }

  result.outputPath = await writeSalesOrderWorkbook(result);

  return result;
}

/**
 * @param {SalesOrderResult} result
 * @returns {string}
 */
export function formatSalesOrderResult(result) {
  if (result.status === "needs_file") {
    return result.notes.join("\n");
  }

  if (result.status === "empty") {
    return [
      "Замовлення Т1 не сформировано.",
      ...result.notes,
      `Источник: ${result.sourceFile}`
    ].join("\n");
  }

  return [
    "Замовлення Т1 подготовлено.",
    `Excel-файл: ${result.outputPath}`,
    `Позиции: ${result.summary.lines}`,
    `Рекомендовано к заказу: ${result.summary.recommendedTotal}`,
    `Фильтр: артикулы ${result.options.skuPrefixes.join(", ")}, запас до ${result.options.maxStockDays} дней`,
    `Формула заказа: Расход * ${result.options.targetPeriods} - Конец`,
    `Источник: ${toProjectPath(resolveProjectPath(result.sourceFile))}`
  ].join("\n");
}

export default {
  run: async input => formatSalesOrderResult(
    await prepareSalesOrder(input)
  )
};
