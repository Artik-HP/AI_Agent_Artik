import fs from "node:fs";
import path from "node:path";

import xlsx from "xlsx";

const PROJECT_ROOT = path.resolve(process.cwd());
const DEFAULT_DATA_DIR = "data";
const MAX_ROWS_PER_SHEET = 10000;
const SPREADSHEET_EXTENSION_PATTERN = "(?:xlsx|xls|csv)(?:\\.(?:xlsx|xls|csv))*";
const PATH_START_PATTERN = "(?:[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/]|[\\p{L}\\p{N}_-]+[\\\\/])";

export const SPREADSHEET_EXTENSIONS = new Set([
  ".csv",
  ".xls",
  ".xlsx"
]);

/**
 * @typedef {Object} ExcelSheet
 * @property {string} name
 * @property {string[]} headers
 * @property {Record<string, string>[]} rows
 */

/**
 * @typedef {Object} ExcelWorkbook
 * @property {string} filePath
 * @property {string} relativePath
 * @property {string} fileName
 * @property {ExcelSheet[]} sheets
 */

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function isSpreadsheetFile(filePath) {
  return SPREADSHEET_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * @param {string} fullPath
 * @returns {boolean}
 */
function isInsideProject(fullPath) {
  const normalizedRoot = PROJECT_ROOT.toLowerCase();
  const normalizedPath = path.resolve(fullPath).toLowerCase();
  const rootWithSeparator = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;

  return normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(rootWithSeparator);
}

/**
 * @param {string} filePath
 * @returns {string}
 */
export function resolveProjectPath(filePath) {
  const normalizedPath = String(filePath || "").trim();

  if (!normalizedPath) {
    throw new Error("Укажи путь к Excel или CSV-файлу.");
  }

  const fullPath = path.resolve(PROJECT_ROOT, normalizedPath);

  if (!isInsideProject(fullPath)) {
    throw new Error("Нельзя читать таблицы вне проекта.");
  }

  return fullPath;
}

/**
 * @param {string} fullPath
 * @returns {string}
 */
export function toProjectPath(fullPath) {
  return path
    .relative(PROJECT_ROOT, fullPath)
    .split(path.sep)
    .join("/");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeCell(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  if (value == null) {
    return "";
  }

  return String(value).trim();
}

/**
 * @param {Record<string, unknown>} row
 * @returns {Record<string, string>}
 */
function normalizeRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      String(key).trim(),
      normalizeCell(value)
    ])
  );
}

/**
 * @param {Record<string, string>} row
 * @returns {boolean}
 */
function hasUsefulCells(row) {
  return Object.values(row).some(value => String(value).trim());
}

/**
 * @param {Record<string, string>[]} rows
 * @returns {string[]}
 */
function collectHeaders(rows) {
  const headers = new Set();

  for (const row of rows) {
    for (const header of Object.keys(row)) {
      if (String(header).trim()) {
        headers.add(header);
      }
    }
  }

  return [...headers];
}

/**
 * @param {string} filePath
 * @param {{ maxRowsPerSheet?: number }} [options]
 * @returns {ExcelWorkbook}
 */
export function loadWorkbook(filePath, options = {}) {
  const fullPath = resolveProjectPath(filePath);
  const maxRowsPerSheet = options.maxRowsPerSheet || MAX_ROWS_PER_SHEET;

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Файл не найден: ${toProjectPath(fullPath)}`);
  }

  if (!isSpreadsheetFile(fullPath)) {
    throw new Error(`Неподдерживаемый формат таблицы: ${toProjectPath(fullPath)}`);
  }

  const workbook = xlsx.readFile(fullPath, {
    cellDates: true
  });

  const sheets = workbook.SheetNames.map(sheetName => {
    const worksheet = workbook.Sheets[sheetName];
    const rawRows = xlsx.utils.sheet_to_json(worksheet, {
      defval: "",
      raw: false
    });

    const rows = rawRows
      .slice(0, maxRowsPerSheet)
      .map(row => normalizeRow(row))
      .filter(hasUsefulCells);

    return {
      name: sheetName,
      headers: collectHeaders(rows),
      rows
    };
  });

  return {
    filePath: fullPath,
    relativePath: toProjectPath(fullPath),
    fileName: path.basename(fullPath),
    sheets
  };
}

/**
 * @param {string[]} filePaths
 * @param {{ maxRowsPerSheet?: number }} [options]
 * @returns {ExcelWorkbook[]}
 */
export function loadWorkbooks(filePaths, options = {}) {
  const uniquePaths = [...new Set(filePaths.map(item => String(item).trim()))]
    .filter(Boolean);

  return uniquePaths.map(filePath => loadWorkbook(filePath, options));
}

/**
 * @param {[number, number][]} spans
 * @param {number} start
 * @param {number} end
 * @returns {boolean}
 */
function overlapsSpan(spans, start, end) {
  return spans.some(([spanStart, spanEnd]) =>
    start < spanEnd && end > spanStart
  );
}

/**
 * @param {Set<string>} result
 * @param {[number, number][]} spans
 * @param {string} filePath
 * @param {number} start
 * @param {number} end
 * @returns {void}
 */
function addSpreadsheetPath(result, spans, filePath, start, end) {
  const normalizedPath = String(filePath || "").trim();

  if (!normalizedPath || overlapsSpan(spans, start, end)) {
    return;
  }

  result.add(normalizedPath);
  spans.push([start, end]);
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractSpreadsheetPaths(text) {
  const value = String(text || "");
  const result = new Set();
  const spans = /** @type {[number, number][]} */ ([]);
  const quotedPattern = new RegExp(
    `"([^"]+\\.${SPREADSHEET_EXTENSION_PATTERN})"`,
    "giu"
  );
  const pathPattern = new RegExp(
    `(${PATH_START_PATTERN}[^\\r\\n,;|"]+?\\.${SPREADSHEET_EXTENSION_PATTERN})`,
    "giu"
  );
  const barePattern = new RegExp(
    `([^\\s,;|"]+?\\.${SPREADSHEET_EXTENSION_PATTERN})`,
    "giu"
  );
  let match = quotedPattern.exec(value);

  while (match) {
    addSpreadsheetPath(
      result,
      spans,
      match[1],
      match.index,
      match.index + match[0].length
    );
    match = quotedPattern.exec(value);
  }

  match = pathPattern.exec(value);

  while (match) {
    addSpreadsheetPath(
      result,
      spans,
      match[1],
      match.index,
      match.index + match[0].length
    );
    match = pathPattern.exec(value);
  }

  match = barePattern.exec(value);

  while (match) {
    addSpreadsheetPath(
      result,
      spans,
      match[1],
      match.index,
      match.index + match[0].length
    );
    match = barePattern.exec(value);
  }

  return [...result];
}

/**
 * @param {string} text
 * @param {string[]} labels
 * @returns {string[]}
 */
export function extractNamedSpreadsheetPaths(text, labels) {
  const escapedLabels = labels.map(label =>
    String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  const pattern = new RegExp(
    `(?:${escapedLabels.join("|")})\\s*[:=]\\s*(?:"([^"]+\\.${SPREADSHEET_EXTENSION_PATTERN})"|(${PATH_START_PATTERN}[^\\r\\n,;|"]+?\\.${SPREADSHEET_EXTENSION_PATTERN})|([^\\s,;|"]+?\\.${SPREADSHEET_EXTENSION_PATTERN}))`,
    "giu"
  );
  const result = new Set();
  let match = pattern.exec(String(text || ""));

  while (match) {
    result.add(String(match[1] || match[2] || match[3]).trim());
    match = pattern.exec(String(text || ""));
  }

  return [...result];
}

/**
 * @param {string} [dir]
 * @param {{ maxFiles?: number }} [options]
 * @returns {string[]}
 */
export function discoverSpreadsheetFiles(dir = DEFAULT_DATA_DIR, options = {}) {
  const maxFiles = options.maxFiles || 30;
  const startDir = resolveProjectPath(dir);

  if (!fs.existsSync(startDir)) {
    return [];
  }

  /** @type {string[]} */
  const found = [];

  /**
   * @param {string} currentDir
   * @returns {void}
   */
  function walk(currentDir) {
    if (found.length >= maxFiles) {
      return;
    }

    const entries = fs.readdirSync(currentDir, {
      withFileTypes: true
    });

    for (const entry of entries) {
      if (found.length >= maxFiles) {
        return;
      }

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (entry.isFile() && isSpreadsheetFile(fullPath)) {
        found.push(toProjectPath(fullPath));
      }
    }
  }

  walk(startDir);

  return found;
}
