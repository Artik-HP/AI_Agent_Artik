import fs from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";

import {
  discoverSpreadsheetFiles,
  existsInProject,
  extractSpreadsheetPaths
} from "./reader.js";
import { normalizeSkuKey, readReportFile } from "./deadStock.js";
import { allocateProportionally } from "./redistribute.js";
import { loadSupplySettings } from "./reportGenerator.js";

const OUTPUT_DIR = "exports";
const FALLBACK_PERIOD_DAYS = 14;

/**
 * @typedef {Object} PointMetrics
 * @property {string} point
 * @property {string} sku
 * @property {string} name
 * @property {number} retail розничные продажи за период
 * @property {number} wholesale продажи покупателю за период
 * @property {number} end остаток на конец периода
 * @property {number} available начало + приход
 * @property {number} expense расход за период
 * @property {number} sellThrough расход / доступно, 0..1
 * @property {number} stockDays на сколько дней хватит ОСТАТКА при текущей скорости
 */

/**
 * @typedef {Object} Criterion
 * @property {string} field поле PointMetrics
 * @property {string} title человеческое название для отчёта
 * @property {boolean} percent показывать как проценты
 * @property {string} op
 * @property {number} value
 */

/**
 * @typedef {Object} CriteriaMoveResult
 * @property {"success"|"empty"|"needs_file"|"needs_criteria"} status
 * @property {string[]} files
 * @property {string|null} source склад-источник, null = любой подходящий
 * @property {Criterion[]} criteria
 * @property {Object[]} lines
 * @property {string|null} outputPath
 * @property {Object} stats
 * @property {string[]} notes
 */

/**
 * Критерии отбора. Реализация стоит первой: «продаж%» должно опознаваться как
 * процент, а не как штуки.
 */
const CRITERIA = [
  {
    field: "sellThrough",
    title: "Реализация",
    percent: true,
    pattern: "реализац|реалізац|sell[ -]?through"
  },
  {
    field: "retail",
    title: "Продажи, шт",
    percent: false,
    pattern: "продаж|продал|sales"
  },
  {
    field: "end",
    title: "Остаток",
    percent: false,
    pattern: "остат|залиш|stock"
  },
  {
    field: "stockDays",
    title: "Дней запаса",
    percent: false,
    pattern: "запас|дней|днів|days"
  }
];

const OPERATORS = {
  "<": (left, right) => left < right,
  "<=": (left, right) => left <= right,
  ">": (left, right) => left > right,
  ">=": (left, right) => left >= right,
  "=": (left, right) => left === right
};

const WORD_OPERATORS = {
  "меньше": "<",
  "менее": "<",
  "менше": "<",
  "больше": ">",
  "более": ">",
  "більше": ">"
};

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
 * «с Т5», «со склада=Т5», «из Х2» → «Т5». Без указания источник любой.
 * @param {string} query
 * @returns {string|null}
 */
export function parseSourcePoint(query) {
  const match = String(query || "").match(
    /(?:^|\s)(?:со?|из|від|from)\s*(?:склада|складу)?\s*[:=]?\s*([\p{L}]\s*\d{1,3})(?!\d)/u
  );

  return match ? match[1].replace(/\s+/g, "").toUpperCase() : null;
}

/**
 * Достаёт условия вида «реализация<20%», «остаток > 10», «продаж меньше 3»,
 * «запас>60». Несколько условий работают через И.
 * @param {string} query
 * @returns {Criterion[]}
 */
export function parseCriteria(query) {
  const text = String(query || "").toLowerCase();
  /** @type {Criterion[]} */
  const found = [];

  for (const criterion of CRITERIA) {
    const match = text.match(new RegExp(
      `(?:${criterion.pattern})[\\p{L}]*\\s*` +
      "(<=|>=|<|>|=|меньше|менее|менше|больше|более|більше)\\s*" +
      "(\\d+(?:[.,]\\d+)?)\\s*(%?)",
      "u"
    ));

    if (!match) {
      continue;
    }

    const op = WORD_OPERATORS[match[1]] || match[1];
    let value = Number(match[2].replace(",", "."));

    // «20%» и «20» для реализации значат одно и то же, а «0.2» — уже доля.
    if (criterion.percent && (match[3] === "%" || value > 1)) {
      value /= 100;
    }

    found.push({
      field: criterion.field,
      title: criterion.title,
      percent: criterion.percent,
      op,
      value
    });
  }

  return found;
}

/**
 * Длина периода из имён файлов («16.08-2.09.2026»), иначе из config.yaml.
 * @param {string[]} files
 * @returns {number}
 */
function resolvePeriodDays(files) {
  const fallback = loadSupplySettings().default_period_days || FALLBACK_PERIOD_DAYS;
  const match = files.join(" ").match(
    /(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?\s*[-–—]\s*(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?/
  );

  if (!match) {
    return fallback;
  }

  const now = new Date();
  const fromYear = Number(match[3] || match[6]) || now.getFullYear();
  const toYear = Number(match[6] || match[3]) || fromYear;
  const from = new Date(fromYear, Number(match[2]) - 1, Number(match[1]));
  const to = new Date(toYear, Number(match[5]) - 1, Number(match[4]));
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;

  return days >= 1 && days <= 180 ? days : fallback;
}

/**
 * Схлопывает строки одного товара на одной точке и считает метрики. Движение
 * (расход, приход, продажи) складывается, снимки (начало, конец) берутся
 * максимальные — один склад может встретиться в двух пересекающихся выгрузках.
 * @param {import("./deadStock.js").DeadStockRecord[]} records
 * @param {number} periodDays
 * @returns {Map<string, Map<string, PointMetrics>>} sku -> точка -> метрики
 */
function groupBySkuAndPoint(records, periodDays) {
  /** @type {Map<string, Map<string, PointMetrics>>} */
  const bySku = new Map();

  for (const record of records) {
    const key = normalizeSkuKey(record.sku);

    if (!key) {
      continue;
    }

    let points = bySku.get(key);

    if (!points) {
      points = new Map();
      bySku.set(key, points);
    }

    const existing = points.get(record.point);

    if (!existing) {
      points.set(record.point, {
        point: record.point,
        sku: record.sku,
        name: record.name,
        retail: record.retail,
        wholesale: record.wholesale,
        end: record.end,
        available: record.start + record.receipt,
        expense: record.expense,
        sellThrough: 0,
        stockDays: 0
      });
      continue;
    }

    existing.retail += record.retail;
    existing.wholesale += record.wholesale;
    existing.expense += record.expense;
    existing.available = Math.max(existing.available, record.start + record.receipt);
    existing.end = Math.max(existing.end, record.end);
    existing.name = existing.name || record.name;
  }

  for (const points of bySku.values()) {
    for (const metrics of points.values()) {
      metrics.sellThrough = metrics.available > 0
        ? metrics.expense / metrics.available
        : 0;
      // Расхода нет — остаток не кончится никогда. Infinity честнее нуля:
      // такая позиция обязана проходить условие «запас > N дней».
      metrics.stockDays = metrics.expense > 0
        ? (metrics.end * periodDays) / metrics.expense
        : Infinity;
    }
  }

  return bySku;
}

/**
 * @param {PointMetrics} metrics
 * @param {Criterion[]} criteria
 * @returns {boolean}
 */
function matchesCriteria(metrics, criteria) {
  return criteria.every(criterion => {
    const compare = OPERATORS[criterion.op];
    const value = metrics[criterion.field];

    return typeof compare === "function" && compare(value, criterion.value);
  });
}

/**
 * @param {Criterion} criterion
 * @returns {string}
 */
export function formatCriterion(criterion) {
  const value = criterion.percent
    ? `${Math.round(criterion.value * 100)}%`
    : criterion.value;

  return `${criterion.title} ${criterion.op} ${value}`;
}

/**
 * @param {CriteriaMoveResult} result
 * @param {string|null} outDir
 * @returns {Promise<string>}
 */
async function writeWorkbook(result, outDir) {
  const dir = outDir ? path.resolve(outDir) : path.resolve(process.cwd(), OUTPUT_DIR);

  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `perenos-po-kriteriyam-${createTimestamp()}.xlsx`);
  const workbook = new ExcelJS.Workbook();

  workbook.creator = "AI_Agent_Artik";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet("Перенос");

  worksheet.columns = [
    { header: "Со склада", key: "from", width: 12 },
    { header: "На склад", key: "to", width: 12 },
    { header: "Артикул", key: "sku", width: 18 },
    { header: "Название", key: "name", width: 44 },
    { header: "Кол-во", key: "qty", width: 10 },
    { header: "Реализация источника", key: "sellThrough", width: 20 },
    { header: "Остаток источника", key: "sourceStock", width: 18 },
    { header: "Продажи получателя", key: "destSales", width: 18 },
    { header: "Доля", key: "share", width: 10 }
  ];

  for (const line of result.lines) {
    worksheet.addRow(line);
  }

  worksheet.getColumn("sellThrough").numFmt = "0%";
  worksheet.getColumn("share").numFmt = "0%";
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: worksheet.columnCount }
  };

  await workbook.xlsx.writeFile(filePath);

  return filePath;
}

/**
 * Переносит товар с точки (или с любой подходящей) на остальные по заданным
 * критериям: «перенеси с Т5 всё где реализация<20%». Отобранная позиция
 * вывозится целиком, объём делится между точками, где она продаётся,
 * пропорционально их розничным продажам.
 * @param {unknown} input
 * @returns {Promise<CriteriaMoveResult>}
 */
export async function buildCriteriaTransfer(input) {
  const request = normalizeInput(input);
  const files = resolveFiles(request);
  const source = parseSourcePoint(request.query);
  const criteria = parseCriteria(request.query);

  if (files.length === 0) {
    return {
      status: "needs_file",
      files: [],
      source,
      criteria,
      lines: [],
      outputPath: null,
      stats: {},
      notes: [
        "Не нашёл отчёты о продажах. Отправь боту выгрузки по точкам (Т1, Т2, … Х2)."
      ]
    };
  }

  if (criteria.length === 0) {
    // Без условия команда неотличима от «развезти по продажам»; лучше показать
    // синтаксис, чем молча увезти всё подряд.
    return {
      status: "needs_criteria",
      files,
      source,
      criteria,
      lines: [],
      outputPath: null,
      stats: {},
      notes: [
        "Не понял критерий. Напиши условие явно, например:",
        "• «перенеси с Т5 где реализация<20%»",
        "• «перенеси с Т5 остаток>10 реализация<40%»",
        "• «перенеси где продаж<3»",
        "• «перенеси с Х2 запас>60»",
        "Критерии: реализация (%), продаж (шт), остаток (шт), запас (дней)."
      ]
    };
  }

  const periodDays = resolvePeriodDays(files);
  /** @type {import("./deadStock.js").DeadStockRecord[]} */
  const records = [];

  for (const file of files) {
    records.push(...readReportFile(file).records);
  }

  const bySku = groupBySkuAndPoint(records, periodDays);
  /** @type {Object[]} */
  const lines = [];
  const points = new Set();
  let matched = 0;
  let noDestination = 0;

  for (const pointMap of bySku.values()) {
    const stocks = [...pointMap.values()];

    stocks.forEach(stock => points.add(stock.point));

    const sources = stocks.filter(stock =>
      (!source || stock.point.toUpperCase() === source) &&
      stock.end > 0 &&
      matchesCriteria(stock, criteria)
    );

    for (const from of sources) {
      matched += 1;

      const destinations = stocks.filter(stock =>
        stock.point !== from.point && stock.retail > 0
      );

      if (destinations.length === 0) {
        noDestination += 1;
        continue;
      }

      const units = Math.floor(from.end);

      if (units < 1) {
        continue;
      }

      const salesTotal = destinations.reduce((sum, stock) => sum + stock.retail, 0);
      const quantities = allocateProportionally(
        units,
        destinations.map(stock => stock.retail)
      );

      destinations.forEach((destination, index) => {
        const qty = quantities[index];

        if (qty < 1) {
          return;
        }

        lines.push({
          from: from.point,
          to: destination.point,
          sku: from.sku,
          name: from.name || destination.name,
          qty,
          sellThrough: Number(from.sellThrough.toFixed(3)),
          sourceStock: from.end,
          destSales: destination.retail,
          share: salesTotal > 0 ? destination.retail / salesTotal : 0
        });
      });
    }
  }

  lines.sort((first, second) =>
    String(first.from).localeCompare(String(second.from)) ||
    String(first.sku).localeCompare(String(second.sku)) ||
    String(first.to).localeCompare(String(second.to))
  );

  const stats = {
    filesRead: files.length,
    periodDays,
    points: points.size,
    skus: bySku.size,
    matched,
    noDestination,
    moves: lines.length,
    units: lines.reduce((sum, line) => sum + Number(line.qty), 0)
  };

  /** @type {CriteriaMoveResult} */
  const result = {
    status: lines.length > 0 ? "success" : "empty",
    files,
    source,
    criteria,
    lines,
    outputPath: null,
    stats,
    notes: []
  };

  if (lines.length === 0) {
    result.notes.push(
      source
        ? `На складе ${source} нет позиций, подходящих под условие.`
        : "Ни одна позиция не подошла под условие."
    );

    return result;
  }

  result.outputPath = await writeWorkbook(result, request.outDir);

  return result;
}

/**
 * @param {CriteriaMoveResult} result
 * @returns {string}
 */
export function formatCriteriaTransferResult(result) {
  if (result.status === "needs_file" || result.status === "needs_criteria") {
    return result.notes.join("\n");
  }

  const conditions = result.criteria.map(formatCriterion).join(", ");

  if (result.status === "empty") {
    return [
      "Перенос не собран.",
      `Условие: ${conditions}`,
      ...result.notes
    ].join("\n");
  }

  const stats = result.stats;

  return [
    "Перенос по критериям готов.",
    `Excel-файл: ${result.outputPath}`,
    `Условие: ${conditions}`,
    `Со склада: ${result.source || "любого подходящего"}`,
    `Файлов: ${stats.filesRead}, складов: ${stats.points}, период: ${stats.periodDays} дн.`,
    `Позиций подошло: ${stats.matched}, некуда везти: ${stats.noDestination}`,
    `Строк переноса: ${stats.moves}, единиц: ${stats.units}`,
    "Позиция вывозится целиком, объём делится пропорционально продажам получателей."
  ].join("\n");
}

export default {
  run: async input => formatCriteriaTransferResult(await buildCriteriaTransfer(input))
};
