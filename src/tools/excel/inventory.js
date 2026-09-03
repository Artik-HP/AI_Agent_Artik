import path from "node:path";

import {
  discoverSpreadsheetFiles,
  existsInProject,
  extractNamedSpreadsheetPaths,
  extractSpreadsheetPaths,
  loadWorkbooks,
  normalizeHeader,
  sortByRecency
} from "./reader.js";
import {
  COLUMN_ALIASES,
  findColumn,
  flattenWorkbookRows,
  getCell,
  getProductKeys,
  normalizeLookupValue,
  parseNumber
} from "./search.js";
import { writePurchaseOrderWorkbook } from "./writer.js";

const DEFAULT_MIN_STOCK = 5;
const DEFAULT_TARGET_MULTIPLIER = 2;

const STOCK_LABELS = [
  "inventory",
  "stock",
  "остатки",
  "остаток",
  "склад"
];

const PRICE_LABELS = [
  "price",
  "prices",
  "supplier",
  "vendor",
  "поставщик",
  "поставщики",
  "прайс",
  "цены"
];

const STOCK_FILE_KEYWORDS = [
  "inventory",
  "stock",
  "остат",
  "склад"
];

const PRICE_FILE_KEYWORDS = [
  "price",
  "supplier",
  "vendor",
  "постав",
  "прайс",
  "цен"
];

/**
 * @typedef {Object} PurchaseOrderLine
 * @property {string} sku
 * @property {string} barcode
 * @property {string} product
 * @property {number} currentStock
 * @property {number} minStock
 * @property {number} targetStock
 * @property {number} orderQuantity
 * @property {string} supplier
 * @property {number|null} price
 * @property {number|null} total
 * @property {string} source
 * @property {string} match
 */

/**
 * @typedef {Object} PurchaseOrderResult
 * @property {"success"|"needs_files"|"empty"} status
 * @property {"no_files"|"not_stock_file"|null} [reason] машиночитаемая причина отказа
 * @property {PurchaseOrderLine[]} lines
 * @property {string[]} stockFiles
 * @property {string[]} priceFiles
 * @property {string|null} outputPath
 * @property {{ lines: number, missingPrice: number, estimatedTotal: number }} summary
 * @property {string[]} notes
 */

/**
 * @typedef {Object} PurchaseOrderInput
 * @property {string} [query]
 * @property {string[]} [memories]
 * @property {string[]} [stockFiles]
 * @property {string[]} [priceFiles]
 */

/**
 * @param {unknown} input
 * @returns {PurchaseOrderInput}
 */
function normalizeInput(input) {
  if (typeof input === "string") {
    return {
      query: input
    };
  }

  if (input && typeof input === "object") {
    return input;
  }

  return {
    query: ""
  };
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
  return [...new Set(values.map(item => String(item || "").trim()))]
    .filter(Boolean);
}

/**
 * @param {string} filePath
 * @param {string[]} keywords
 * @returns {boolean}
 */
function hasFileKeyword(filePath, keywords) {
  const fileName = normalizeHeader(path.basename(filePath));

  return keywords.some(keyword =>
    fileName.includes(normalizeHeader(keyword))
  );
}

/**
 * @param {string[]} files
 * @returns {{ stockFiles: string[], priceFiles: string[] }}
 */
function classifyFiles(files) {
  const stockFiles = [];
  const priceFiles = [];
  const unknownFiles = [];

  for (const file of files) {
    if (hasFileKeyword(file, PRICE_FILE_KEYWORDS)) {
      priceFiles.push(file);
      continue;
    }

    if (hasFileKeyword(file, STOCK_FILE_KEYWORDS)) {
      stockFiles.push(file);
      continue;
    }

    unknownFiles.push(file);
  }

  if (stockFiles.length === 0 && unknownFiles.length > 0) {
    stockFiles.push(unknownFiles.shift());
  }

  if (priceFiles.length === 0 && unknownFiles.length > 0) {
    priceFiles.push(...unknownFiles);
  }

  return {
    stockFiles,
    priceFiles
  };
}

/**
 * @param {string} query
 * @param {string[]} memories
 * @returns {{ stockFiles: string[], priceFiles: string[] }}
 */
function collectFiles(query, memories) {
  const memoryText = memories.join("\n");
  const stockFiles = unique([
    ...extractNamedSpreadsheetPaths(query, STOCK_LABELS),
    ...extractNamedSpreadsheetPaths(memoryText, STOCK_LABELS)
  ]);
  const priceFiles = unique([
    ...extractNamedSpreadsheetPaths(query, PRICE_LABELS),
    ...extractNamedSpreadsheetPaths(memoryText, PRICE_LABELS)
  ]);
  // Явный путь в запросе — прямое указание пользователя, он идёт первым.
  // Остальное (память + автопоиск) сортируем по свежести: спрашивают всегда
  // про только что присланный файл, а не про первый по алфавиту.
  const queryFiles = unique(extractSpreadsheetPaths(query)).filter(existsInProject);
  const discoveredFiles = sortByRecency(
    unique([
      ...extractSpreadsheetPaths(memoryText),
      ...discoverSpreadsheetFiles()
    ]).filter(existsInProject)
  );
  const allFiles = unique([...queryFiles, ...discoveredFiles]);
  const alreadyNamed = new Set([...stockFiles, ...priceFiles]);
  const unnamedFiles = allFiles.filter(file =>
    !alreadyNamed.has(file) &&
    !/^[^\\/]+[=:]/.test(file)
  );
  const classified = classifyFiles(unnamedFiles);

  return {
    stockFiles: unique([...stockFiles, ...classified.stockFiles]),
    priceFiles: unique([...priceFiles, ...classified.priceFiles])
  };
}

/**
 * @param {string} text
 * @param {string[]} memories
 * @returns {number}
 */
function getDefaultMinStock(text, memories) {
  const combined = `${text}\n${memories.join("\n")}`;
  const match = combined.match(
    /(?:min|min_stock|порог|минимальный остаток|мин остаток)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i
  );

  if (!match) {
    return DEFAULT_MIN_STOCK;
  }

  return parseNumber(match[1]) || DEFAULT_MIN_STOCK;
}

/**
 * @param {{ source: import("./search.js").RowSource, row: Record<string, string> }} item
 * @param {number} defaultMinStock
 * @returns {PurchaseOrderLine|null}
 */
function createInventoryLine(item, defaultMinStock) {
  const currentStock = parseNumber(getCell(item.row, COLUMN_ALIASES.stock));

  if (currentStock === null) {
    return null;
  }

  const minStock =
    parseNumber(getCell(item.row, COLUMN_ALIASES.minStock)) ??
    defaultMinStock;
  const targetStock =
    parseNumber(getCell(item.row, COLUMN_ALIASES.targetStock)) ??
    Math.max(minStock * DEFAULT_TARGET_MULTIPLIER, minStock + 1);

  if (currentStock > minStock) {
    return null;
  }

  const product =
    getCell(item.row, COLUMN_ALIASES.name) ||
    getCell(item.row, COLUMN_ALIASES.sku) ||
    getCell(item.row, COLUMN_ALIASES.barcode);

  if (!product) {
    return null;
  }

  return {
    sku: getCell(item.row, COLUMN_ALIASES.sku),
    barcode: getCell(item.row, COLUMN_ALIASES.barcode),
    product,
    currentStock,
    minStock,
    targetStock,
    orderQuantity: Math.max(1, Math.ceil(targetStock - currentStock)),
    supplier: "",
    price: null,
    total: null,
    source: `${item.source.file}, ${item.source.sheet}, строка ${item.source.rowNumber}`,
    match: ""
  };
}

/**
 * @typedef {Object} SupplierOffer
 * @property {string[]} keys
 * @property {string} supplier
 * @property {number} price
 * @property {string} source
 */

/**
 * @param {{ source: import("./search.js").RowSource, row: Record<string, string> }} item
 * @returns {SupplierOffer|null}
 */
function createSupplierOffer(item) {
  const price = parseNumber(getCell(item.row, COLUMN_ALIASES.price));

  if (price === null) {
    return null;
  }

  const keys = getProductKeys(item.row);

  if (keys.length === 0) {
    return null;
  }

  return {
    keys,
    supplier:
      getCell(item.row, COLUMN_ALIASES.supplier) ||
      path.basename(item.source.file, path.extname(item.source.file)),
    price,
    source: `${item.source.file}, ${item.source.sheet}, строка ${item.source.rowNumber}`
  };
}

/**
 * @param {SupplierOffer[]} offers
 * @returns {Map<string, SupplierOffer[]>}
 */
function indexOffers(offers) {
  const index = new Map();

  for (const offer of offers) {
    for (const key of offer.keys) {
      if (!index.has(key)) {
        index.set(key, []);
      }

      index.get(key).push(offer);
    }
  }

  return index;
}

/**
 * @param {PurchaseOrderLine} line
 * @param {Map<string, SupplierOffer[]>} offerIndex
 * @param {SupplierOffer[]} offers
 * @returns {SupplierOffer|null}
 */
function findBestOffer(line, offerIndex, offers) {
  const keys = unique([
    normalizeLookupValue(line.sku),
    normalizeLookupValue(line.barcode),
    normalizeLookupValue(line.product)
  ]);
  const directOffers = keys.flatMap(key => offerIndex.get(key) || []);
  const candidates = directOffers.length > 0
    ? directOffers
    : offers.filter(offer =>
      offer.keys.some(key =>
        key.includes(normalizeLookupValue(line.product)) ||
        normalizeLookupValue(line.product).includes(key)
      )
    );

  if (candidates.length === 0) {
    return null;
  }

  return [...new Set(candidates)].sort(
    (first, second) => first.price - second.price
  )[0];
}

/**
 * @param {PurchaseOrderLine[]} lines
 * @param {SupplierOffer[]} offers
 * @returns {PurchaseOrderLine[]}
 */
function enrichWithSupplierPrices(lines, offers) {
  const offerIndex = indexOffers(offers);

  return lines.map(line => {
    const bestOffer = findBestOffer(line, offerIndex, offers);

    if (!bestOffer) {
      return line;
    }

    return {
      ...line,
      supplier: bestOffer.supplier,
      price: bestOffer.price,
      total: bestOffer.price * line.orderQuantity,
      match: bestOffer.source
    };
  });
}

/**
 * @param {PurchaseOrderLine[]} lines
 * @returns {{ lines: number, missingPrice: number, estimatedTotal: number }}
 */
function summarizeOrder(lines) {
  return {
    lines: lines.length,
    missingPrice: lines.filter(line => line.price === null).length,
    estimatedTotal: lines.reduce(
      (sum, line) => sum + (line.total || 0),
      0
    )
  };
}

/**
 * @param {PurchaseOrderInput|string|unknown} input
 * @returns {Promise<PurchaseOrderResult>}
 */
export async function preparePurchaseOrder(input) {
  const request = normalizeInput(input);
  const query = String(request.query || "");
  const memories = Array.isArray(request.memories) ? request.memories : [];
  const collected = collectFiles(query, memories);
  const stockFiles = unique([
    ...(request.stockFiles || []),
    ...collected.stockFiles
  ]);
  const priceFiles = unique([
    ...(request.priceFiles || []),
    ...collected.priceFiles
  ]);

  if (stockFiles.length === 0) {
    return {
      status: "needs_files",
      reason: "no_files",
      lines: [],
      stockFiles: [],
      priceFiles,
      outputPath: null,
      summary: {
        lines: 0,
        missingPrice: 0,
        estimatedTotal: 0
      },
      notes: [
        "Я не нашёл файл остатков.",
        "Положи Excel/CSV в папку data или отправь файл боту в Telegram.",
        "Пример: /excel заказ остатки=data/ostatki.xlsx прайс=data/price.xlsx"
      ]
    };
  }

  const defaultMinStock = getDefaultMinStock(query, memories);
  const stockWorkbooks = loadWorkbooks(stockFiles);

  // Ни в одном листе нет колонки с остатком/количеством — это не файл остатков
  // (например прислали список перемещения). Честно скажем, а не «заказ не нужен».
  const hasStockColumn = stockWorkbooks.some(workbook =>
    workbook.sheets.some(sheet => findColumn(sheet.headers, COLUMN_ALIASES.stock))
  );

  if (!hasStockColumn) {
    return {
      status: "needs_files",
      reason: "not_stock_file",
      lines: [],
      stockFiles,
      priceFiles,
      outputPath: null,
      summary: { lines: 0, missingPrice: 0, estimatedTotal: 0 },
      notes: [
        "Это не похоже на файл остатков: нет колонки с количеством/остатком.",
        "Для заказа поставщику нужен отчёт Т1 (Начало/Расход/Конец) или остатки с колонкой «Остаток».",
        `Проверил: ${stockFiles.join(", ")}`
      ]
    };
  }

  const priceWorkbooks = priceFiles.length > 0
    ? loadWorkbooks(priceFiles)
    : [];
  const stockRows = flattenWorkbookRows(stockWorkbooks);
  const priceRows = flattenWorkbookRows(priceWorkbooks);
  const lowStockLines = stockRows
    .map(item => createInventoryLine(item, defaultMinStock))
    .filter(Boolean);
  const offers = priceRows
    .map(createSupplierOffer)
    .filter(Boolean);
  const lines = enrichWithSupplierPrices(lowStockLines, offers)
    .sort((first, second) =>
      first.product.localeCompare(second.product, "ru")
    );

  if (lines.length === 0) {
    return {
      status: "empty",
      lines: [],
      stockFiles,
      priceFiles,
      outputPath: null,
      summary: {
        lines: 0,
        missingPrice: 0,
        estimatedTotal: 0
      },
      notes: [
        "Товары ниже минимального остатка не найдены."
      ]
    };
  }

  const result = {
    status: "success",
    lines,
    stockFiles,
    priceFiles,
    outputPath: null,
    summary: summarizeOrder(lines),
    notes: []
  };

  result.outputPath = await writePurchaseOrderWorkbook(result);

  return result;
}

/**
 * @param {PurchaseOrderResult} result
 * @returns {string}
 */
export function formatPurchaseOrderResult(result) {
  if (result.status === "needs_files") {
    return result.notes.join("\n");
  }

  if (result.status === "empty") {
    return [
      "Заказ поставщику не нужен.",
      ...result.notes,
      `Проверенные остатки: ${result.stockFiles.join(", ")}`
    ].join("\n");
  }

  return [
    "Заказ поставщику подготовлен.",
    `Excel-файл: ${result.outputPath}`,
    `Позиции к заказу: ${result.summary.lines}`,
    `Без найденной цены: ${result.summary.missingPrice}`,
    `Предварительная сумма: ${result.summary.estimatedTotal.toFixed(2)}`,
    `Остатки: ${result.stockFiles.join(", ")}`,
    `Прайсы: ${result.priceFiles.join(", ") || "не указаны"}`
  ].join("\n");
}

export async function runPurchaseOrderTool(input) {
  const result = await preparePurchaseOrder(input);

  return formatPurchaseOrderResult(result);
}

export function lowStock(rows, defaultMinStock = DEFAULT_MIN_STOCK) {
  return rows
    .map(item => createInventoryLine(item, defaultMinStock))
    .filter(Boolean);
}

export function zeroStock(rows) {
  return rows.filter(item => {
    const stock = parseNumber(getCell(item.row, COLUMN_ALIASES.stock));

    return stock !== null && stock <= 0;
  });
}

export function updateQuantity(row, quantity) {
  return {
    ...row,
    quantity
  };
}

export function addProduct(rows, product) {
  return [...rows, product];
}

export function removeProduct(rows, predicate) {
  return rows.filter(row => !predicate(row));
}
