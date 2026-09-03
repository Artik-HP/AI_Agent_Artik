import fs from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";
import xlsx from "xlsx";

import {
  discoverSpreadsheetFiles,
  existsInProject,
  extractSpreadsheetPaths,
  resolveProjectPath,
  toProjectPath
} from "./reader.js";

const OUTPUT_DIR = "exports";
// Единая заглушка для обеих колонок склада: лист «не знаю» у пользователя
// значит ровно это, и нечитаемый "?" рядом с ним смотрелся чужеродно.
const UNKNOWN_LOCATION = "не знаю";

/**
 * @typedef {Object} TransferLine
 * @property {string} from склад-источник
 * @property {string} to склад-получатель (имя листа)
 * @property {string} sku
 * @property {string} note свободный комментарий из строки
 * @property {string} sheet исходный лист
 * @property {number} sourceRow
 */

/**
 * @typedef {Object} TransferResult
 * @property {"success"|"empty"|"needs_file"} status
 * @property {string} from
 * @property {string[]} files
 * @property {TransferLine[]} lines
 * @property {string|null} outputPath
 * @property {{ sheets: number, lines: number, byDestination: Record<string, number> }} stats
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
 * Похоже ли значение на артикул: нет пробелов, есть хотя бы одна цифра,
 * разумная длина. Ловит SO3206, 62530064-00132, pr186-pack, 2031.
 * @param {unknown} value
 * @returns {boolean}
 */
function looksLikeSku(value) {
  const text = String(value ?? "").trim();

  return (
    text.length >= 2 &&
    text.length <= 40 &&
    !/\s/.test(text) &&
    /\d/.test(text) &&
    !/^\d+[.,]\d+$/.test(text)
  );
}

/**
 * Т и Х пользователь пишет кириллицей, а в именах файлов они часто латиницей
 * («t11.xlsx»). Приводим к тому виду, в котором названы листы-получатели.
 * @param {string} letter
 * @param {string} digits
 * @returns {string}
 */
function normalizeStoreCode(letter, digits) {
  const map = { T: "Т", X: "Х" };
  const upper = String(letter).toUpperCase();

  return (map[upper] || upper) + digits;
}

/**
 * Ищет код склада в имени файла: «t11», «Т5 перемещение», «переміщення Х2».
 * Префикс времени загрузки из Telegram («1788459346140-») не мешает: он весь из
 * цифр, а коду нужна буква вплотную перед числом. Длинные числа (даты,
 * таймстемпы) отсекаются — у складов номера в одну-три цифры.
 * @param {string} base имя файла без расширения
 * @returns {string|null}
 */
function findStoreCode(base) {
  const match = String(base)
    .replace(/^\d{6,}-/, "")
    .match(/(?<![\p{L}\d])(\p{L})\s*(\d{1,3})(?!\d)/u);

  return match ? normalizeStoreCode(match[1], match[2]) : null;
}

/**
 * Склад-источник. Внутри книги его нет вообще — ни шапки, ни свойств, имена
 * листов заняты получателями. Поэтому источников ровно два: текст запроса и имя
 * файла, в таком порядке доверия.
 * Из «переміщення з Т11.xlsx» достаёт «Т11». Можно переопределить в запросе:
 * «со склада=Т5» / «з Т5».
 * @param {string} query
 * @param {string} fileName
 * @returns {string}
 */
function resolveSource(query, fileName) {
  const explicit = String(query || "").match(
    /(?:со?\s*склада|источник|from|з|из|від)\s*[:=]?\s*([\p{L}]+\s*\d+)/u
  );

  if (explicit) {
    return explicit[1].replace(/\s+/g, "");
  }

  const base = fileName.replace(/\.[^.]+$/, "");
  const fromName = base.match(
    /(?:перем[іи]щенн?[яе]|перенос|transfer)\s+(?:з|с|из|від|from)\s+(.+)$/i
  );

  if (fromName) {
    return fromName[1].trim();
  }

  // Имя вида «переміщення з Т11» — не единственное: файл могли переименовать в
  // «t11.xlsx» или «Т5 перемещение.xlsx». Раньше всё это молча давало "?".
  return findStoreCode(base) || UNKNOWN_LOCATION;
}

/**
 * Имя листа → склад-получатель. «на Т9» → «Т9», «Т2  » → «Т2», «не знаю» как есть.
 * @param {string} sheetName
 * @returns {string}
 */
function destinationFromSheet(sheetName) {
  return String(sheetName || "")
    .trim()
    .replace(/^на\s+/i, "")
    .trim() || UNKNOWN_LOCATION;
}

/**
 * Разбирает строку листа: находит артикул и собирает остальное в примечание.
 * @param {unknown[]} row
 * @returns {{ sku: string, note: string }|null}
 */
function parseTransferRow(row) {
  const cells = (Array.isArray(row) ? row : [])
    .map(cell => String(cell ?? "").trim())
    .filter(Boolean);

  if (cells.length === 0) {
    return null;
  }

  const skuIndex = cells.findIndex(looksLikeSku);
  const sku = skuIndex === -1 ? cells[0] : cells[skuIndex];
  const note = cells
    .filter((_, index) => index !== (skuIndex === -1 ? 0 : skuIndex))
    .join("; ");

  return { sku, note };
}

/**
 * @param {string} filePath
 * @param {string} from
 * @returns {TransferLine[]}
 */
function readTransferFile(filePath, from) {
  const workbook = xlsx.readFile(resolveProjectPath(filePath), { cellDates: true });
  /** @type {TransferLine[]} */
  const lines = [];

  for (const sheetName of workbook.SheetNames) {
    const to = destinationFromSheet(sheetName);
    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      defval: "",
      raw: false,
      blankrows: false
    });

    rows.forEach((row, index) => {
      const parsed = parseTransferRow(row);

      if (parsed) {
        lines.push({
          from,
          to,
          sku: parsed.sku,
          note: parsed.note,
          sheet: sheetName,
          sourceRow: index + 1
        });
      }
    });
  }

  return lines;
}

/**
 * @typedef {Object} TransferShape
 * @property {number} sheets количество листов в книге
 * @property {number} rows всего непустых строк
 * @property {number} skuRows строк, где первая заполненная ячейка похожа на артикул
 * @property {number} maxCells наибольшее число заполненных ячеек в одной строке
 */

/**
 * Считает форму книги, не разбирая её как перемещение: сколько листов, строк,
 * сколько строк начинается с артикула и насколько строки "широкие".
 * @param {string} filePath
 * @returns {TransferShape}
 */
function readTransferShape(filePath) {
  const workbook = xlsx.readFile(resolveProjectPath(filePath), { cellDates: true });
  let rows = 0;
  let skuRows = 0;
  let maxCells = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheetRows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      defval: "",
      raw: false,
      blankrows: false
    });

    for (const row of sheetRows) {
      const cells = (Array.isArray(row) ? row : [])
        .map(cell => String(cell ?? "").trim())
        .filter(Boolean);

      if (cells.length === 0) {
        continue;
      }

      rows += 1;
      maxCells = Math.max(maxCells, cells.length);

      if (looksLikeSku(cells[0])) {
        skuRows += 1;
      }
    }
  }

  return {
    sheets: workbook.SheetNames.length,
    rows,
    skuRows,
    maxCells
  };
}

/**
 * Похож ли файл на список перемещения, а не на отчёт/остатки. Нужно, чтобы
 * "Заказ поставщику" с таким файлом не упирался в отказ, а собрал то, чем файл
 * на самом деле является. Отчёт Т1: одна шапка, десятки колонок, первая ячейка
 * строки — название товара. Перемещение: листы-магазины, столбик артикулов,
 * шапки нет, в строке 1-3 ячейки.
 * @param {string} filePath
 * @returns {boolean}
 */
export function looksLikeTransferFile(filePath) {
  /** @type {TransferShape} */
  let shape;

  try {
    shape = readTransferShape(filePath);
  } catch {
    return false;
  }

  if (shape.rows === 0) {
    return false;
  }

  const skuShare = shape.skuRows / shape.rows;

  // Отчёт и остатки — широкая таблица с шапкой: десяток колонок в строке.
  // Перемещение — узкий столбик артикулов, рядом изредка приписка словами.
  // Узкий файл остатков сюда не попадёт по построению: функция вызывается
  // только тогда, когда колонка остатка в книге уже не нашлась.
  return shape.maxCells <= 4 && skuShare >= 0.6;
}

/**
 * @param {unknown} input
 * @returns {{ query: string, memories: string[], files: string[], outDir: string|null }}
 */
function normalizeInput(input) {
  if (typeof input === "string") {
    return { query: input, memories: [], files: [], outDir: null };
  }

  if (input && typeof input === "object") {
    const record = /** @type {Record<string, unknown>} */ (input);

    return {
      query: String(record.query || ""),
      memories: Array.isArray(record.memories) ? record.memories.map(String) : [],
      files: Array.isArray(record.files) ? record.files.map(String) : [],
      outDir: record.outDir ? String(record.outDir) : null
    };
  }

  return { query: "", memories: [], files: [], outDir: null };
}

/**
 * @param {{ query: string, memories: string[], files: string[] }} request
 * @returns {string[]}
 */
function resolveFiles(request) {
  if (request.files.length > 0) {
    return [...new Set(request.files)].filter(existsInProject);
  }

  const named = [
    ...new Set([
      ...extractSpreadsheetPaths(request.query),
      ...extractSpreadsheetPaths(request.memories.join("\n"))
    ])
  ].filter(existsInProject);

  return named.length > 0 ? named : discoverSpreadsheetFiles();
}

/**
 * @param {TransferResult} result
 * @param {string|null} outDir
 * @returns {Promise<string>}
 */
async function writeTransferWorkbook(result, outDir) {
  const dir = outDir ? path.resolve(outDir) : path.resolve(process.cwd(), OUTPUT_DIR);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `peremeshchenie-${createTimestamp()}.xlsx`);
  const workbook = new ExcelJS.Workbook();

  workbook.creator = "AI_Agent_Artik";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet("Перемещение");
  worksheet.columns = [
    { header: "Со склада", key: "from", width: 12 },
    { header: "На склад", key: "to", width: 14 },
    { header: "Артикул", key: "sku", width: 20 },
    { header: "Название", key: "name", width: 44 },
    { header: "Кол-во", key: "qty", width: 10 },
    { header: "Примечание", key: "note", width: 32 }
  ];

  for (const line of result.lines) {
    worksheet.addRow({
      from: line.from,
      to: line.to,
      sku: line.sku,
      name: "",
      qty: "",
      note: line.note
    });
  }

  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = { from: "A1", to: "F1" };

  await workbook.xlsx.writeFile(filePath);

  return filePath;
}

/**
 * @param {unknown} input
 * @returns {Promise<TransferResult>}
 */
export async function buildTransferDoc(input) {
  const request = normalizeInput(input);
  const files = resolveFiles(request);

  if (files.length === 0) {
    return {
      status: "needs_file",
      from: UNKNOWN_LOCATION,
      files: [],
      lines: [],
      outputPath: null,
      stats: { sheets: 0, lines: 0, byDestination: {} },
      notes: [
        "Не нашёл файл перемещения. Отправь боту Excel со списком артикулов по листам-магазинам."
      ]
    };
  }

  /** @type {TransferLine[]} */
  const lines = [];
  const sheets = new Set();
  let from = UNKNOWN_LOCATION;

  for (const file of files) {
    const fileName = toProjectPath(resolveProjectPath(file)).split("/").pop() || file;
    from = resolveSource(request.query, fileName);

    for (const line of readTransferFile(file, from)) {
      lines.push(line);
      sheets.add(`${fileName}::${line.sheet}`);
    }
  }

  /** @type {Record<string, number>} */
  const byDestination = {};
  for (const line of lines) {
    byDestination[line.to] = (byDestination[line.to] || 0) + 1;
  }

  /** @type {TransferResult} */
  const result = {
    status: lines.length > 0 ? "success" : "empty",
    from,
    files,
    lines,
    outputPath: null,
    stats: { sheets: sheets.size, lines: lines.length, byDestination },
    notes: []
  };

  if (lines.length === 0) {
    result.notes.push("В файле не нашлось строк с артикулами.");

    return result;
  }

  result.outputPath = await writeTransferWorkbook(result, request.outDir);

  return result;
}

/**
 * @param {TransferResult} result
 * @returns {string}
 */
export function formatTransferResult(result) {
  if (result.status === "needs_file") {
    return result.notes.join("\n");
  }

  if (result.status === "empty") {
    return ["Документ перемещения не собран.", ...result.notes].join("\n");
  }

  const breakdown = Object.entries(result.stats.byDestination)
    .map(([destination, count]) => `${destination} — ${count}`)
    .join(", ");

  return [
    "Документ перемещения готов.",
    `Excel-файл: ${result.outputPath}`,
    `Со склада: ${result.from}`,
    `Листов-получателей: ${result.stats.sheets}`,
    `Позиций всего: ${result.stats.lines}`,
    `По складам: ${breakdown}`,
    "Колонки «Название» и «Кол-во» пустые — заполни вручную."
  ].join("\n");
}

export default {
  run: async input => formatTransferResult(await buildTransferDoc(input))
};
