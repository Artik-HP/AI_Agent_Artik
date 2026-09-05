import fs from "node:fs";
import path from "node:path";

import xlsx from "xlsx";

const PROJECT_ROOT = path.resolve(process.cwd());
const DEFAULT_DATA_DIR = "data";
const MAX_ROWS_PER_SHEET = 10000;
const MAX_SCANNED_FILES = 500;
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
 * Существует ли файл внутри проекта. Кандидаты из запроса/памяти бывают
 * устаревшими или испорченными (спецсимвол в имени → ложный путь), поэтому
 * такие отсеиваем ДО загрузки, а не ловим исключение «Файл не найден».
 * @param {string} filePath
 * @returns {boolean}
 */
export function existsInProject(filePath) {
  try {
    return fs.existsSync(resolveProjectPath(filePath));
  } catch {
    return false;
  }
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
 * Список путей приходит вперемешку (запрос + память + автопоиск). Устаревший
 * или испорченный путь из памяти не должен ронять всю операцию: несуществующие
 * отбрасываем и грузим остальные. Ошибку кидаем, только если валидных нет вовсе,
 * и НЕ подставляем в неё битый путь — иначе пользователь видит мусор из памяти.
 * @param {string[]} filePaths
 * @param {{ maxRowsPerSheet?: number }} [options]
 * @returns {ExcelWorkbook[]}
 */
export function loadWorkbooks(filePaths, options = {}) {
  const uniquePaths = [...new Set(filePaths.map(item => String(item).trim()))]
    .filter(Boolean);
  const existing = uniquePaths.filter(existsInProject);

  if (existing.length === 0 && uniquePaths.length > 0) {
    throw new Error(
      "Не нашёл ни одного из указанных файлов. Отправь отчёт боту заново или укажи путь явно."
    );
  }

  return existing.map(filePath => loadWorkbook(filePath, options));
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
 * Убирает из текста запроса пути к таблицам, оставляя только слова человека.
 *
 * Своими силами это делали два места, и оба одинаково ломались на путях с
 * пробелами: шаблон `\S+\.xlsx` обрывается на первом пробеле, и хвост пути
 * («…/1788545822690-Т1») оставался внутри искомой фразы. «Оставь только pjur
 * data/Т1 18.06.xlsx» искал строки со словами «pjur data/Т1» и находил ноль.
 * Здесь путь вырезается тем же разбором, что и находит его, — вместе с
 * кавычками, если он был закавычен.
 * @param {string} text
 * @returns {string}
 */
export function stripSpreadsheetPaths(text) {
  let result = String(text || "");

  for (const filePath of extractSpreadsheetPaths(result)) {
    for (const variant of [
      `"${filePath}"`,
      `'${filePath}'`,
      `«${filePath}»`,
      filePath
    ]) {
      result = result.split(variant).join(" ");
    }
  }

  return result.replace(/\s+/g, " ").trim();
}

/**
 * @typedef {Object} SheetMatrix
 * @property {string} name имя вкладки
 * @property {unknown[][]} rows строки как массивы ячеек (header: 1)
 */

/**
 * Читает ВСЕ вкладки книги как матрицы строк. Модули разбора отчётов раньше
 * брали SheetNames[0] напрямую и молча теряли остальные вкладки; теперь точка
 * входа одна. raw:true оставляет числа числами (нужно отчёту движения),
 * raw:false отдаёт форматированные строки.
 * @param {string} filePath
 * @param {{ raw?: boolean }} [options]
 * @returns {SheetMatrix[]}
 */
export function readSheetMatrices(filePath, options = {}) {
  const workbook = xlsx.readFile(resolveProjectPath(filePath), {
    cellDates: true
  });

  return workbook.SheetNames.map(name => ({
    name,
    rows: xlsx.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      defval: "",
      raw: options.raw === true,
      blankrows: false
    })
  }));
}

/**
 * Строка-склад отчёта движения: в первой колонке название точки, вторая
 * (наименование) пустая, дальше идут числа. Именно ею 1С открывает блок
 * каждого магазина.
 * @param {unknown[]} row
 * @returns {boolean}
 */
export function looksLikeSectionRow(row) {
  const cells = Array.isArray(row) ? row : [];
  const first = String(cells[0] ?? "").trim();
  const second = String(cells[1] ?? "").trim();

  if (!first || second || /^\d/.test(first)) {
    return false;
  }

  // «Разом»/«Итого» — строка итога, а не склад.
  if (/^(?:разом|итого|всього|всего|total)$/i.test(first)) {
    return false;
  }

  // Артикул с пустым наименованием — не склад. В реальной выгрузке такие
  // строки есть («SO8611» без названия), и раньше каждая из них открывала
  // новый фантомный «магазин»: всё, что шло дальше по листу, уезжало на него.
  // Название точки либо содержит пробел («Toppers 02 Lviv Staroevreyska»),
  // либо не содержит цифр, либо это голый код точки вида «Т1».
  const looksLikePointName =
    /\s/.test(first) || !/\d/.test(first) || /^[ТTХXтtхx]\s*-?\s*\d{1,3}$/.test(first);

  if (!looksLikePointName) {
    return false;
  }

  return cells.slice(2).some(cell => {
    const text = String(cell ?? "").replace(/\s/g, "").replace(",", ".");

    return text !== "" && Number.isFinite(Number(text));
  });
}

/**
 * Отбирает вкладки, которые действительно являются выгрузкой движения.
 *
 * Люди держат в той же книге свои рабочие листы: «40% і більше» (отфильтрованная
 * копия), «Замовлення» (черновик заказа). Раньше читались все вкладки подряд, и
 * каждая становилась отдельной «торговой точкой»: в заказе по одному реальному
 * файлу 211 позиций из 515 приезжали с листа-черновика — тот же товар второй раз.
 *
 * Признак настоящей выгрузки — строка-склад: 1С открывает ею блок каждого
 * магазина, а ручная копия строк её не содержит. Если строк-складов нет нигде
 * (выгрузка без группировки по складам, книга перемещения с листами-магазинами),
 * возвращаем всё как было — молча потерять данные хуже, чем прочитать лишнее.
 * @param {SheetMatrix[]} sheets
 * @returns {SheetMatrix[]}
 */
export function selectReportSheets(sheets) {
  const list = Array.isArray(sheets) ? sheets : [];
  const withSection = list.filter(sheet =>
    (Array.isArray(sheet.rows) ? sheet.rows : []).some(looksLikeSectionRow)
  );

  return withSection.length > 0 ? withSection : list;
}

/**
 * Книга — это выгрузка движения из 1С, а не рукописный список?
 *
 * Признак прямой: строка-склад («Toppers 07 …») или служебная шапка выгрузки
 * («Номенклатура.Артикул»). Оба встречаются только в отчёте.
 *
 * Нужен там, где под команду подсовывают не тот файл: книга перемещения и
 * выгрузка движения обе про товар, обе .xlsx, и разбор перемещения молча
 * выдавал по строке на каждый товар отчёта.
 * @param {string} filePath
 * @returns {boolean}
 */
export function looksLikeMovementReport(filePath) {
  try {
    return readSheetMatrices(filePath).some(sheet => {
      const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
      const head = rows
        .slice(0, 3)
        .flat()
        .map(cell => String(cell ?? "").toLowerCase())
        .join(" ");

      return (
        head.includes("номенклатура.артикул") ||
        head.includes("мiсце зберiгання") ||
        head.includes("місце зберігання") ||
        rows.some(looksLikeSectionRow)
      );
    });
  } catch {
    return false;
  }
}

/**
 * Имя вкладки как название точки/склада — но только если вкладок больше одной.
 * В книге из одного листа имя служебное ("TDSheet" из 1С, "Лист1"), точку там
 * даёт имя файла. Никто не называет двенадцать вкладок "TDSheet", поэтому
 * количество вкладок и есть признак осмысленности имени.
 * @param {string} sheetName
 * @param {number} sheetCount
 * @returns {string|null} null — брать точку из имени файла
 */
export function sheetPointName(sheetName, sheetCount) {
  if (sheetCount < 2) {
    return null;
  }

  return String(sheetName || "")
    .replace(/^на\s+/i, "")
    .trim() || null;
}

/**
 * @param {string} filePath
 * @returns {number} время изменения в мс, 0 если файл недоступен
 */
function fileModifiedAt(filePath) {
  try {
    return fs.statSync(resolveProjectPath(filePath)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Свежий файл важнее старого: пользователь спрашивает про то, что только что
 * прислал боту, а обход каталога отдаёт файлы в алфавитном порядке. Сортируем
 * по времени изменения, недоступные файлы уходят в конец.
 * @param {string[]} filePaths
 * @returns {string[]}
 */
export function sortByRecency(filePaths) {
  return filePaths
    .map(filePath => ({
      filePath,
      modifiedAt: fileModifiedAt(filePath)
    }))
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .map(item => item.filePath);
}

/**
 * @param {string} [dir]
 * @param {{ maxFiles?: number, skipDirs?: string[] }} [options] skipDirs —
 *   каталоги, в которые не заходим (например чужие загрузки в data/telegram)
 * @returns {string[]}
 */
export function discoverSpreadsheetFiles(dir = DEFAULT_DATA_DIR, options = {}) {
  const maxFiles = options.maxFiles || 30;
  const scanLimit = Math.max(maxFiles, MAX_SCANNED_FILES);
  const startDir = resolveProjectPath(dir);
  const skipDirs = new Set(
    (options.skipDirs || []).map(item => toProjectPath(resolveProjectPath(item)))
  );

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
    if (found.length >= scanLimit) {
      return;
    }

    const entries = fs.readdirSync(currentDir, {
      withFileTypes: true
    });

    for (const entry of entries) {
      if (found.length >= scanLimit) {
        return;
      }

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (skipDirs.has(toProjectPath(fullPath))) {
          continue;
        }

        walk(fullPath);
        continue;
      }

      if (entry.isFile() && isSpreadsheetFile(fullPath)) {
        found.push(toProjectPath(fullPath));
      }
    }
  }

  walk(startDir);

  return sortByRecency(found).slice(0, maxFiles);
}
