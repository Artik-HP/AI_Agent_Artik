import path from "node:path";

import { NORMALIZED_MOVEMENT_LABELS } from "./columns.js";
import {
  createTimestamp,
  normalizeInput,
  resolveFiles
} from "./shared.js";
import { writeReportWorkbook } from "./writer.js";
import {
  normalizeHeader,
  readSheetMatrices,
  resolveProjectPath,
  sheetPointName,
  toProjectPath
} from "./reader.js";
import { parseNumber } from "./search.js";
import { rememberPointName } from "./points.js";

/**
 * Тексты заголовков, по которым находим колонки продаж. Раскладка выгрузок
 * 1С/BAS у разных точек разная (у одних есть «Оприходование запасов», у других
 * «Возврат поставщику» и т.п.), поэтому колонку ищем по названию, не по индексу.
 */
const RETAIL_LABELS = NORMALIZED_MOVEMENT_LABELS.retailSales;
const WHOLESALE_LABELS = NORMALIZED_MOVEMENT_LABELS.buyerSales;
const END_LABELS = NORMALIZED_MOVEMENT_LABELS.end;

/** Базовые колонки движения — нужны, чтобы посчитать реализацию и запас. */
const START_LABELS = NORMALIZED_MOVEMENT_LABELS.start;
const RECEIPT_LABELS = NORMALIZED_MOVEMENT_LABELS.receipt;
const EXPENSE_LABELS = NORMALIZED_MOVEMENT_LABELS.expense;

/** Первые две колонки выгрузки BAS — всегда артикул и наименование. */
const SKU_HEADER = "Артикул";
const NAME_HEADER = "Наименование";

/** Служебные колонки, которые добавляем слева в итоговый файл. */
const EXTRA_HEADERS = ["Точка", "Файл", "Розница за период", "Опт за период"];

/**
 * @typedef {Object} DeadStockRecord
 * @property {string} file имя исходного файла
 * @property {string} point торговая точка (из строки-склада или из имени файла)
 * @property {string} sku
 * @property {string} name
 * @property {number} retail розничные продажи в этой строке
 * @property {number} wholesale продажи покупателю в этой строке
 * @property {number} end остаток на конец периода
 * @property {number} start остаток на начало периода
 * @property {number} receipt приход за период
 * @property {number} expense расход за период (всё, что ушло со склада)
 * @property {Record<string, string>} cells все ячейки строки по display-заголовку
 */

/**
 * @typedef {Object} DeadStockGroup
 * @property {string} key нормализованный артикул
 * @property {string} sku
 * @property {string} name
 * @property {number} retail сумма розницы по артикулу за период
 * @property {number} wholesale сумма опта по артикулу за период
 * @property {DeadStockRecord[]} records
 */

/**
 * @typedef {Object} DeadStockResult
 * @property {"success"|"empty"|"needs_file"} status
 * @property {string[]} files
 * @property {string[]} columns объединённый список колонок исходных данных
 * @property {{ group: DeadStockGroup, rec: DeadStockRecord }[]} outputRecords
 * @property {Object} stats
 * @property {string|null} outputPath
 * @property {string[]} notes
 */

/**
 * «Т12_продажи_...xlsx» → «Т12». Запасной вариант, если в файле нет строк-складов.
 * @param {string} filePath
 * @returns {string}
 */
function pointFromFileName(filePath) {
  const base = path.basename(String(filePath || ""));
  const match = base.match(/^([\p{L}]+\s*\d+)/u);

  return (match ? match[1] : base.replace(/\.[^.]+$/, "")).trim();
}

/**
 * Строка-склад: в первой колонке название точки, вторая пустая, дальше числа
 * (это подытог склада). Такие строки задают «текущую точку» для строк ниже.
 * @param {unknown[]} row
 * @returns {boolean}
 */
export function isSectionHeader(row) {
  const first = String(row[0] || "").trim();
  const second = String(row[1] || "").trim();

  if (!first || second || first === "Разом" || /^\d/.test(first)) {
    return false;
  }

  return row.slice(2).some(cell => parseNumber(cell) !== null);
}

/**
 * Строка товара: есть артикул и наименование, это не строка-заголовок таблицы.
 * @param {unknown[]} row
 * @returns {boolean}
 */
function isProductRow(row) {
  const sku = String(row[0] || "").trim();
  const name = String(row[1] || "").trim();

  return Boolean(
    sku &&
    name &&
    sku !== "Номенклатура.Артикул" &&
    !/^номенклатура\b/i.test(sku)
  );
}

/**
 * Ключ, по которому один и тот же товар «склеивается» между файлами.
 *
 * @param {string} sku
 * @returns {string}
 */
export function normalizeSkuKey(sku) {
  // Склейка намеренно консервативная: регистр + обрезка пробелов. "so4848" и
  // "SO4848 " — один товар, а "SO4848-test" и "SO4848", "108" и "0108" остаются
  // РАЗНЫМИ: лучше не склеить два разных товара, чем молча слить их в один.
  return String(sku || "").trim().toUpperCase();
}

/**
 * Правило «непроданного»: за весь период по артикулу не было ни розничных
 * продаж, ни продаж покупателю (опт не спасает — так решил закупщик).
 * @param {{ retail: number, wholesale: number }} totals
 * @returns {boolean}
 */
function isDeadStock(totals) {
  return totals.retail === 0 && totals.wholesale === 0;
}

/**
 * @param {Record<string, string>} cells
 * @returns {number}
 */
function filledCellCount(cells) {
  return Object.values(cells).filter(value => String(value).trim()).length;
}
/**
 * Разбирает одну вкладку отчёта движения: находит колонки продаж и остатка по
 * тексту заголовков, тянет «точку» из строк-складов внутри листа.
 * @param {import("./reader.js").SheetMatrix} sheet
 * @param {{ file: string, point: string }} context
 * @returns {{ headers: string[], records: DeadStockRecord[] }}
 */
function readReportSheet(sheet, context) {
  const rows = sheet.rows;
  const headerRow = Array.isArray(rows[0]) ? rows[0] : [];
  const columnHeaders = headerRow.map((cell, index) => {
    if (index === 0) return SKU_HEADER;
    if (index === 1) return NAME_HEADER;

    const text = String(cell || "").trim();
    return text || `Колонка ${index + 1}`;
  });
  const normalized = columnHeaders.map(normalizeHeader);
  const retailIndex = normalized.findIndex(header =>
    RETAIL_LABELS.some(label => header === label || header.includes(label))
  );
  const wholesaleIndex = normalized.findIndex(header =>
    WHOLESALE_LABELS.some(label => header === label || header.includes(label))
  );
  const endIndex = normalized.findIndex(header =>
    END_LABELS.some(label => header === label || header.includes(label))
  );
  const startIndex = normalized.findIndex(header =>
    START_LABELS.some(label => header === label || header.includes(label))
  );
  const receiptIndex = normalized.findIndex(header =>
    RECEIPT_LABELS.some(label => header === label || header.includes(label))
  );
  const expenseIndex = normalized.findIndex(header =>
    EXPENSE_LABELS.some(label => header === label || header.includes(label))
  );

  // Точка листа — стартовая; строка-склад внутри листа перебивает её, она
  // конкретнее (выгрузка одной вкладкой может содержать несколько складов).
  let point = context.point;
  /** @type {DeadStockRecord[]} */
  const records = [];

  for (let i = 1; i < rows.length; i += 1) {
    const row = Array.isArray(rows[i]) ? rows[i] : [];

    if (isSectionHeader(row)) {
      point = String(row[0]).trim();
      // Реестр точек запоминает, что «Toppers 01 Lviv Gnatuka» — это Т1;
      // без этого запрос «перенеси с Т1» не нашёл бы ни одной строки.
      rememberPointName(point);
      continue;
    }

    if (!isProductRow(row)) {
      continue;
    }

    /** @type {Record<string, string>} */
    const cells = {};
    columnHeaders.forEach((header, index) => {
      cells[header] = String(row[index] ?? "").trim();
    });

    records.push({
      file: context.file,
      point,
      sku: String(row[0]).trim(),
      name: String(row[1]).trim(),
      retail: retailIndex === -1 ? 0 : parseNumber(row[retailIndex]) || 0,
      wholesale: wholesaleIndex === -1 ? 0 : parseNumber(row[wholesaleIndex]) || 0,
      end: endIndex === -1 ? 0 : parseNumber(row[endIndex]) || 0,
      start: startIndex === -1 ? 0 : parseNumber(row[startIndex]) || 0,
      receipt: receiptIndex === -1 ? 0 : parseNumber(row[receiptIndex]) || 0,
      expense: expenseIndex === -1 ? 0 : parseNumber(row[expenseIndex]) || 0,
      cells
    });
  }

  return { headers: columnHeaders, records };
}

/**
 * Разбирает отчёт движения целиком: каждая вкладка — своя точка со своей
 * раскладкой колонок. Используется и отчётом по непроданному, и
 * перераспределением остатков (redistribute.js).
 * @param {string} filePath
 * @returns {{ headers: string[], records: DeadStockRecord[] }}
 */
export function readReportFile(filePath) {
  const fullPath = resolveProjectPath(filePath);
  const fileName = toProjectPath(fullPath).split("/").pop() || String(filePath);
  const sheets = readSheetMatrices(filePath);
  const filePoint = pointFromFileName(filePath);
  /** @type {string[]} */
  const headers = [];
  /** @type {DeadStockRecord[]} */
  const records = [];

  for (const sheet of sheets) {
    const parsed = readReportSheet(sheet, {
      file: fileName,
      point: sheetPointName(sheet.name, sheets.length) || filePoint
    });

    for (const header of parsed.headers) {
      if (!headers.includes(header)) {
        headers.push(header);
      }
    }

    records.push(...parsed.records);
  }

  return { headers, records };
}

/**
 * @param {DeadStockResult} result
 * @param {string|null} outDir
 * @returns {Promise<string>}
 */
async function writeDeadStockWorkbook(result, outDir) {
  const headers = [...EXTRA_HEADERS, ...result.columns];
  const rows = result.outputRecords.map(({ group, rec }) => {
    /** @type {Record<string, unknown>} */
    const row = {
      "Точка": rec.point,
      "Файл": rec.file,
      "Розница за период": group.retail,
      "Опт за период": group.wholesale
    };

    for (const header of result.columns) {
      const raw = rec.cells[header] ?? "";

      if (header === SKU_HEADER || header === NAME_HEADER) {
        row[header] = raw;
        continue;
      }

      const asNumber = parseNumber(raw);

      row[header] = asNumber === null ? raw : asNumber;
    }

    return row;
  });

  return await writeReportWorkbook({
    fileName: `neprodano-${createTimestamp()}`,
    sheetName: "Непродано",
    outDir,
    columns: headers.map(header => ({
      header,
      width: header === NAME_HEADER ? 60 : header.length > 18 ? 22 : 14
    })),
    rows
  });
}

/**
 * @param {unknown} input
 * @returns {Promise<DeadStockResult>}
 */
export async function analyzeDeadStock(input) {
  const request = normalizeInput(input);
  const files = resolveFiles(request);

  if (files.length === 0) {
    return {
      status: "needs_file",
      files: [],
      columns: [],
      outputRecords: [],
      stats: {},
      outputPath: null,
      notes: [
        "Не нашёл Excel-файлы отчётов о продажах.",
        "Укажи файлы в запросе или отправь их боту в Telegram."
      ]
    };
  }

  const columns = [SKU_HEADER, NAME_HEADER];
  const seen = new Set(columns.map(normalizeHeader));
  /** @type {DeadStockRecord[]} */
  const allRecords = [];

  for (const file of files) {
    const { headers, records } = readReportFile(file);

    for (const header of headers) {
      const norm = normalizeHeader(header);

      if (!seen.has(norm)) {
        seen.add(norm);
        columns.push(header);
      }
    }

    allRecords.push(...records);
  }

  /** @type {Map<string, DeadStockGroup>} */
  const groups = new Map();

  for (const rec of allRecords) {
    const key = normalizeSkuKey(rec.sku);

    if (!key) {
      continue;
    }

    let group = groups.get(key);

    if (!group) {
      group = { key, sku: rec.sku, name: rec.name, retail: 0, wholesale: 0, records: [] };
      groups.set(key, group);
    }

    group.retail += rec.retail;
    group.wholesale += rec.wholesale;
    group.records.push(rec);
  }

  const deadGroups = [...groups.values()].filter(isDeadStock);

  // Гранулярность «артикул × точка»: одна строка на пару. Если товар пришёл из
  // нескольких пересекающихся выгрузок (напр. Toppers 01 есть и в Т1, и в Т12),
  // берём самую заполненную строку и склеиваем имена файлов в колонку «Файл».
  /** @type {Map<string, { group: DeadStockGroup, rec: DeadStockRecord, files: Set<string> }>} */
  const byPointKey = new Map();
  let overlaps = 0;

  for (const group of deadGroups) {
    for (const rec of group.records) {
      const key = `${group.key}@@${rec.point}`;
      const existing = byPointKey.get(key);

      if (!existing) {
        byPointKey.set(key, { group, rec, files: new Set([rec.file]) });
        continue;
      }

      if (!existing.files.has(rec.file)) {
        overlaps += 1;
      }

      existing.files.add(rec.file);

      if (filledCellCount(rec.cells) > filledCellCount(existing.rec.cells)) {
        existing.rec = rec;
      }
    }
  }

  const outputRecords = [...byPointKey.values()]
    .map(entry => ({
      group: entry.group,
      rec: { ...entry.rec, file: [...entry.files].sort().join(", ") }
    }))
    .sort((first, second) =>
      first.group.key.localeCompare(second.group.key) ||
      String(first.rec.point).localeCompare(String(second.rec.point))
    );

  const stats = {
    filesRead: files.length,
    productRecords: allRecords.length,
    uniqueSkus: groups.size,
    deadSkus: deadGroups.length,
    deadRows: outputRecords.length,
    overlapRows: overlaps
  };

  /** @type {DeadStockResult} */
  const result = {
    status: outputRecords.length > 0 ? "success" : "empty",
    files,
    columns,
    outputRecords,
    stats,
    outputPath: null,
    notes: []
  };

  if (outputRecords.length === 0) {
    result.notes.push(
      "За период у всех артикулов были розничные или оптовые продажи — «непроданного» нет."
    );

    return result;
  }

  result.outputPath = await writeDeadStockWorkbook(result, request.outDir);

  return result;
}

/**
 * @param {DeadStockResult} result
 * @returns {string}
 */
export function formatDeadStockResult(result) {
  if (result.status === "needs_file") {
    return result.notes.join("\n");
  }

  if (result.status === "empty") {
    return ["Непроданное не сформировано.", ...result.notes].join("\n");
  }

  const stats = result.stats;
  const lines = [
    "Отчёт по непроданному товару готов.",
    `Excel-файл: ${result.outputPath}`,
    `Файлов обработано: ${stats.filesRead}`,
    `Строк товаров прочитано: ${stats.productRecords}`,
    `Уникальных артикулов за период: ${stats.uniqueSkus}`,
    `Не продавалось ни в розницу, ни оптом: ${stats.deadSkus} артикулов`,
    `Строк в файле (артикул × точка): ${stats.deadRows}`
  ];

  if (stats.overlapRows > 0) {
    lines.push(
      `Внимание: ${stats.overlapRows} строк собрано из пересекающихся выгрузок ` +
        "(один склад в нескольких файлах) — в колонке «Файл» перечислены все источники."
    );
  }

  return lines.join("\n");
}

export default {
  run: async input => formatDeadStockResult(await analyzeDeadStock(input))
};
