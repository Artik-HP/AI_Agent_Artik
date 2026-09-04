import { normalizeHeader } from "./reader.js";

/**
 * @typedef {Record<string, string | number | null | undefined>} RowData
 */

/**
 * @typedef {Object} ColumnAliases
 * @property {string[]} barcode
 * @property {string[]} category
 * @property {string[]} minStock
 * @property {string[]} name
 * @property {string[]} price
 * @property {string[]} sku
 * @property {string[]} stock
 * @property {string[]} supplier
 * @property {string[]} targetStock
 */

/**
 * @typedef {Object} RowSource
 * @property {string} file
 * @property {string} sheet
 * @property {number} rowNumber
 */

/**
 * @typedef {Object} SearchMatch
 * @property {RowSource} source
 * @property {RowData} row
 */

/**
 * @typedef {Object} SearchOptions
 * @property {string[]} [columns]
 * @property {number} [limit]
 */

/**
 * @typedef {Object} ExcelSheet
 * @property {string} name
 * @property {RowData[]} rows
 */

/**
 * @typedef {Object} ExcelWorkbook
 * @property {string} relativePath
 * @property {ExcelSheet[]} sheets
 */

/**
 * @type {ColumnAliases}
 */
export const COLUMN_ALIASES = {
  barcode: [
    "barcode",
    "ean",
    "upc",
    "штрих код",
    "штрихкод"
  ],
  category: [
    "category",
    "группа",
    "категория",
    "раздел"
  ],
  minStock: [
    "min stock",
    "minimum",
    "reorder point",
    "минимальный остаток",
    "мин остаток",
    "порог",
    "точка заказа"
  ],
  name: [
    "item",
    "name",
    "product",
    "product name",
    "название",
    "наименование",
    "номенклатура",
    "товар"
  ],
  price: [
    "cost",
    "price",
    "wholesale",
    "закупочная цена",
    "опт",
    "оптовая цена",
    "прайс",
    "цена"
  ],
  sku: [
    "article",
    "id",
    "sku",
    "vendor code",
    "артикул",
    "код",
    "код товара"
  ],
  stock: [
    "balance",
    "qty",
    "quantity",
    "stock",
    "кол во",
    "количество",
    "наличие",
    "остатки",
    "остаток"
  ],
  supplier: [
    "provider",
    "supplier",
    "vendor",
    "контрагент",
    "поставщик"
  ],
  targetStock: [
    "max stock",
    "target",
    "target stock",
    "до уровня",
    "максимальный остаток",
    "норма",
    "целевой остаток"
  ]
};

/**
 * @param {string[]} headers
 * @param {string[]} aliases
 * @returns {string|null}
 */
export function findColumn(headers, aliases) {
  const normalizedAliases = aliases.map(normalizeHeader);
  let bestColumn = null;
  let bestScore = 0;

  for (const header of headers) {
    const normalizedHeader = normalizeHeader(header);

    for (const alias of normalizedAliases) {
      if (!alias) {
        continue;
      }

      let score = 0;

      if (normalizedHeader === alias) {
        score = 4;
      } else if (normalizedHeader.includes(alias)) {
        score = 3;
      } else if (alias.includes(normalizedHeader) && normalizedHeader.length > 2) {
        score = 2;
      }

      if (score > bestScore) {
        bestScore = score;
        bestColumn = header;
      }
    }
  }

  return bestColumn;
}

/**
 * @param {Record<string, string>} row
 * @param {string[]} aliases
 * @returns {string}
 */
export function getCell(row, aliases) {
  const column = findColumn(Object.keys(row), aliases);

  if (!column) {
    return "";
  }

  return String(row[column] || "").trim();
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseNumber(value) {
  const raw = String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^0-9,.-]/g, "");

  if (!raw) {
    return null;
  }

  const normalized = raw.includes(",") && !raw.includes(".")
    ? raw.replace(",", ".")
    : raw.replace(/,/g, "");
  const number = Number(normalized);

  return Number.isFinite(number) ? number : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeLookupValue(value) {
  return normalizeHeader(String(value ?? ""))
    .replace(/\s+/g, "");
}

/**
 * @param {Record<string, string>} row
 * @returns {string[]}
 */
export function getProductKeys(row) {
  const values = [
    getCell(row, COLUMN_ALIASES.sku),
    getCell(row, COLUMN_ALIASES.barcode),
    getCell(row, COLUMN_ALIASES.name)
  ];

  return [...new Set(values.map(normalizeLookupValue).filter(Boolean))];
}

/**
 * @param {import("./reader.js").ExcelWorkbook[]} workbooks
 * @returns {{ source: RowSource, row: Record<string, string> }[]}
 */
export function flattenWorkbookRows(workbooks) {
  return workbooks.flatMap(workbook =>
    workbook.sheets.flatMap(sheet =>
      sheet.rows.map((row, index) => ({
        source: {
          file: workbook.relativePath,
          sheet: sheet.name,
          rowNumber: index + 2
        },
        row
      }))
    )
  );
}

/**
 * @param {import("./reader.js").ExcelWorkbook[]} workbooks
 * @param {string} query
 * @param {{ columns?: string[], limit?: number }} [options]
 * @returns {SearchMatch[]}
 */
export function searchRows(workbooks, query, options = {}) {
  const normalizedQuery = normalizeHeader(query);
  const columns = (options.columns || []).map(normalizeHeader);
  const limit = options.limit || 20;

  if (!normalizedQuery) {
    return [];
  }

  const matches = [];

  for (const item of flattenWorkbookRows(workbooks)) {
    const entries = Object.entries(item.row);
    const values = columns.length > 0
      ? entries.filter(([key]) => columns.includes(normalizeHeader(key)))
      : entries;
    const haystack = values
      .map(([key, value]) => `${key} ${value}`)
      .join(" ");

    if (normalizeHeader(haystack).includes(normalizedQuery)) {
      matches.push(item);
    }

    if (matches.length >= limit) {
      break;
    }
  }

  return matches;
}
