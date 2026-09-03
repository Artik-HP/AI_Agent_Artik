import {
  COLUMN_ALIASES,
  flattenWorkbookRows,
  getCell,
  parseNumber
} from "./search.js";

/**
 * @typedef {Object} WorkbookAnalytics
 * @property {number} files
 * @property {number} sheets
 * @property {number} rows
 * @property {{ file: string, sheets: number, rows: number }[]} byFile
 */

/**
 * @param {import("./reader.js").ExcelWorkbook[]} workbooks
 * @returns {WorkbookAnalytics}
 */
export function summarizeWorkbooks(workbooks) {
  const byFile = workbooks.map(workbook => ({
    file: workbook.relativePath,
    sheets: workbook.sheets.length,
    rows: workbook.sheets.reduce(
      (sum, sheet) => sum + sheet.rows.length,
      0
    )
  }));

  return {
    files: workbooks.length,
    sheets: workbooks.reduce(
      (sum, workbook) => sum + workbook.sheets.length,
      0
    ),
    rows: byFile.reduce((sum, item) => sum + item.rows, 0),
    byFile
  };
}

/**
 * @param {{ row: Record<string, string> }[]} rows
 * @returns {number}
 */
export function totalPrice(rows) {
  return rows.reduce((sum, item) => {
    const price = parseNumber(getCell(item.row, COLUMN_ALIASES.price));
    const quantity =
      parseNumber(getCell(item.row, COLUMN_ALIASES.stock)) || 1;

    return sum + (price || 0) * quantity;
  }, 0);
}

/**
 * @param {{ row: Record<string, string> }[]} rows
 * @returns {number}
 */
export function averagePrice(rows) {
  const prices = rows
    .map(item => parseNumber(getCell(item.row, COLUMN_ALIASES.price)))
    .filter(price => price !== null);

  if (prices.length === 0) {
    return 0;
  }

  return prices.reduce((sum, price) => sum + price, 0) / prices.length;
}

/**
 * @param {{ row: Record<string, string> }[]} rows
 * @param {"asc"|"desc"} direction
 * @returns {{ row: Record<string, string>, price: number }|null}
 */
function extremePrice(rows, direction) {
  const pricedRows = rows
    .map(item => ({
      row: item.row,
      price: parseNumber(getCell(item.row, COLUMN_ALIASES.price))
    }))
    .filter(item => item.price !== null);

  if (pricedRows.length === 0) {
    return null;
  }

  return pricedRows.sort((first, second) =>
    direction === "asc"
      ? first.price - second.price
      : second.price - first.price
  )[0];
}

/**
 * @param {{ row: Record<string, string> }[]} rows
 * @returns {{ row: Record<string, string>, price: number }|null}
 */
export function mostExpensive(rows) {
  return extremePrice(rows, "desc");
}

/**
 * @param {{ row: Record<string, string> }[]} rows
 * @returns {{ row: Record<string, string>, price: number }|null}
 */
export function cheapest(rows) {
  return extremePrice(rows, "asc");
}

/**
 * @param {{ row: Record<string, string> }[]} rows
 * @returns {number}
 */
export function countProducts(rows) {
  return rows.length;
}

/**
 * @param {{ row: Record<string, string> }[]} rows
 * @param {number} defaultMinStock
 * @returns {{ total: number, lowStock: number, zeroStock: number }}
 */
export function summarizeInventory(rows, defaultMinStock = 5) {
  let lowStockCount = 0;
  let zeroStockCount = 0;

  for (const item of rows) {
    const stock = parseNumber(getCell(item.row, COLUMN_ALIASES.stock));
    const minStock =
      parseNumber(getCell(item.row, COLUMN_ALIASES.minStock)) ??
      defaultMinStock;

    if (stock === null) {
      continue;
    }

    if (stock <= 0) {
      zeroStockCount += 1;
    }

    if (stock <= minStock) {
      lowStockCount += 1;
    }
  }

  return {
    total: rows.length,
    lowStock: lowStockCount,
    zeroStock: zeroStockCount
  };
}

/**
 * @param {import("./reader.js").ExcelWorkbook[]} workbooks
 * @returns {string}
 */
export function formatWorkbookAnalytics(workbooks) {
  const summary = summarizeWorkbooks(workbooks);
  const rows = flattenWorkbookRows(workbooks);
  const inventory = summarizeInventory(rows);

  return [
    "Excel-аналитика:",
    `Файлов: ${summary.files}`,
    `Листов: ${summary.sheets}`,
    `Строк: ${summary.rows}`,
    `Товаров с низким остатком: ${inventory.lowStock}`,
    `Нулевых остатков: ${inventory.zeroStock}`,
    `Средняя цена: ${averagePrice(rows).toFixed(2)}`,
    "",
    "Файлы:",
    ...summary.byFile.map(item =>
      `- ${item.file}: листов ${item.sheets}, строк ${item.rows}`
    )
  ].join("\n");
}
