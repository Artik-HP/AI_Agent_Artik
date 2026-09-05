import fs from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";

import {
  createTimestamp,
  normalizeInput,
  OUTPUT_DIR,
  resolveFiles
} from "./shared.js";
import { readReportFile } from "./deadStock.js";
import {
  comparePointCodes,
  knownPoints,
  normalizePointCode,
  parseSourcePoint,
  pointName
} from "./points.js";
import { writeReportWorkbook } from "./writer.js";

/**
 * Два способа собрать перемещение, не создавая книгу руками.
 *
 * 1. Шаблон: бот отдаёт книгу, где на каждый магазин сети уже заведён лист с
 *    правильным именем маршрута («Т10 на Т1») и шапкой. Человеку остаётся
 *    вписать артикулы — а это ровно та часть, которую нельзя автоматизировать.
 * 2. Текстом: «Т10 на Т1: SO3206 12, PJ10440 2» прямо в чат. Для двух-трёх
 *    позиций открывать Excel незачем.
 *
 * Имя файла-шаблона намеренно выглядит как обычная книга перемещения
 * («Переміщення з Т10.xlsx»): заполненный шаблон возвращается боту, и он
 * должен пройти через тот же разбор, что и книга, сделанная руками.
 */

/** Сколько выгрузок читаем, наполняя реестр точек для шаблона. */
const MAX_SCANNED_REPORTS = 8;

/** Заголовки листа шаблона: ровно то, что читает transferDoc. */
const TEMPLATE_HEADERS = ["Артикул", "Кількість"];

/**
 * @typedef {Object} TemplateResult
 * @property {"success"|"needs_source"|"needs_points"} status
 * @property {string|null} source код склада-источника
 * @property {string[]} destinations коды получателей
 * @property {string|null} outputPath
 * @property {string[]} notes
 */

/**
 * @typedef {Object} TextTransferResult
 * @property {"success"|"empty"} status
 * @property {{ from: string, to: string, sku: string, qty: number|null }[]} lines
 * @property {string|null} outputPath
 * @property {{ routes: number, lines: number, units: number }} stats
 * @property {string[]} notes
 */

/**
 * Просят ли шаблон книги перемещения.
 * @param {string} query
 * @returns {boolean}
 */
export function isTemplateRequest(query) {
  const text = String(query || "");

  return (
    /(?:шаблон|бланк|заготовк[ауи]|болванк[ауи]|template)/i.test(text) &&
    /перем[іие]щ|перенос|transfer/i.test(text)
  );
}

/**
 * Наполняет реестр точек, если он пуст: имена магазинов бот выучивает из
 * строк-складов, а после перезапуска процесса реестр начинается с нуля.
 * @param {import("./shared.js").ExcelRequest} request
 * @returns {string[]} коды точек
 */
function collectPoints(request) {
  if (knownPoints().length > 0) {
    return knownPoints();
  }

  // Читаем не до первой удачи, а несколько выгрузок подряд: сеть по частям
  // разбросана по файлам, и отчёт одной точки дал бы шаблон на один лист.
  // Потолок — чтобы шаблон не превращался в перечитывание всего пула.
  for (const file of resolveFiles(request).slice(0, MAX_SCANNED_REPORTS)) {
    try {
      readReportFile(file);
    } catch {
      // Битая книга в пуле не должна мешать собрать шаблон по остальным.
    }
  }

  return knownPoints();
}

/**
 * Книга-шаблон: лист на каждый магазин-получатель.
 * @param {unknown} input
 * @returns {Promise<TemplateResult>}
 */
export async function buildTransferTemplate(input) {
  const request = normalizeInput(input);
  const source = parseSourcePoint(request.query) ||
    normalizePointCode(String(request.query || "").match(/шаблон[^\p{L}]*(?:перем[іие]щенн?[яе]|перенос\w*)?\s+([\p{L}]\s*\d{1,3})/iu)?.[1]);
  const points = collectPoints(request);

  if (!source) {
    return {
      status: "needs_source",
      source: null,
      destinations: [],
      outputPath: null,
      notes: [
        "С какого магазина везём? Напиши, например: «шаблон перемещения с Т10».",
        points.length > 0
          ? `Известные точки: ${points.join(", ")}.`
          : "Точки бот пока не знает — пришли любую выгрузку продаж, он их выучит."
      ]
    };
  }

  const destinations = points
    .filter(code => code !== source)
    .sort(comparePointCodes);

  if (destinations.length === 0) {
    return {
      status: "needs_points",
      source,
      destinations: [],
      outputPath: null,
      notes: [
        "Не знаю, какие ещё есть магазины: реестр точек пуст.",
        "Пришли боту выгрузку продаж (любую) — он выучит названия из строк-складов."
      ]
    };
  }

  const outputDir = path.resolve(process.cwd(), request.outDir || OUTPUT_DIR);
  const filePath = path.join(outputDir, `Переміщення з ${source}.xlsx`);
  const workbook = new ExcelJS.Workbook();

  fs.mkdirSync(outputDir, { recursive: true });

  workbook.creator = "AI_Agent_Artik";
  workbook.created = new Date();

  for (const destination of destinations) {
    const worksheet = workbook.addWorksheet(`${source} на ${destination}`);

    worksheet.columns = [
      { header: TEMPLATE_HEADERS[0], key: "sku", width: 22 },
      { header: TEMPLATE_HEADERS[1], key: "qty", width: 12 }
    ];
    worksheet.getRow(1).font = { bold: true };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];

    // Подпись магазина — человеку, а не разбору: колонка D за пределами
    // читаемых данных, в разбор она не попадёт.
    worksheet.getCell("D1").value = pointName(destination);
    worksheet.getCell("D1").font = { italic: true, color: { argb: "FF888888" } };
  }

  await workbook.xlsx.writeFile(filePath);

  return {
    status: "success",
    source,
    destinations,
    outputPath: filePath,
    notes: []
  };
}

/**
 * @param {TemplateResult} result
 * @returns {string}
 */
export function formatTemplateResult(result) {
  if (result.status !== "success") {
    return result.notes.join("\n");
  }

  return [
    `Шаблон перемещения с ${result.source} готов.`,
    `Excel-файл: ${result.outputPath}`,
    `Листов: ${result.destinations.length} — ${result.destinations
      .map(code => `${result.source} на ${code}`)
      .join(", ")}`,
    "Впиши артикул и количество на нужных листах, лишние листы можно не трогать.",
    "Готовый файл пришли обратно и нажми «🔀 Перемещение»."
  ].join("\n");
}

/**
 * Разбирает перемещение, записанное текстом:
 *   Т10 на Т1: SO3206 12, PJ10440 2
 *   Т10 на Т2: BIO_2005 1
 * Маршрут задаётся строкой «X на Y», позиции — «артикул количество» через
 * запятую, точку с запятой или перенос строки. Количество можно не писать.
 * @param {string} text
 * @returns {{ from: string, to: string, sku: string, qty: number|null }[]}
 */
export function parseTransferText(text) {
  /** @type {{ from: string, to: string, sku: string, qty: number|null }[]} */
  const lines = [];
  /** @type {{ from: string, to: string }|null} */
  let route = null;

  for (const rawLine of String(text || "").split(/[\r\n]+/)) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    const header = line.match(
      /^([\p{L}]\s*\d{1,3})\s*(?:на|->|→|=>)\s*([\p{L}]\s*\d{1,3})\s*:?\s*(.*)$/iu
    );

    if (header) {
      const from = normalizePointCode(header[1]);
      const to = normalizePointCode(header[2]);

      route = from && to ? { from, to } : null;

      if (route && header[3].trim()) {
        lines.push(...parseItems(header[3], route));
      }

      continue;
    }

    if (route) {
      lines.push(...parseItems(line, route));
    }
  }

  return lines;
}

/**
 * «SO3206 12, PJ10440 2» → позиции маршрута.
 * @param {string} text
 * @param {{ from: string, to: string }} route
 * @returns {{ from: string, to: string, sku: string, qty: number|null }[]}
 */
function parseItems(text, route) {
  /** @type {{ from: string, to: string, sku: string, qty: number|null }[]} */
  const items = [];

  for (const chunk of String(text).split(/[,;]+/)) {
    const parts = chunk.trim().split(/\s+/).filter(Boolean);

    if (parts.length === 0) {
      continue;
    }

    // Артикул — то, где есть цифра и нет пробела; количество — число справа.
    const sku = parts[0];

    if (!/\d/.test(sku) || sku.length < 2) {
      continue;
    }

    const tail = parts[1];
    const qty = tail !== undefined && /^\d{1,4}(?:[.,]\d{1,3})?$/.test(tail)
      ? Number(tail.replace(",", "."))
      : null;

    items.push({ from: route.from, to: route.to, sku, qty });
  }

  return items;
}

/**
 * Есть ли в сообщении перемещение, записанное текстом.
 * @param {string} query
 * @returns {boolean}
 */
export function hasTransferText(query) {
  return parseTransferText(query).length > 0;
}

/**
 * Собирает документ перемещения прямо из текста сообщения — без Excel.
 * @param {unknown} input
 * @returns {Promise<TextTransferResult>}
 */
export async function buildTransferFromText(input) {
  const request = normalizeInput(input);
  const lines = parseTransferText(request.query);

  if (lines.length === 0) {
    return {
      status: "empty",
      lines: [],
      outputPath: null,
      stats: { routes: 0, lines: 0, units: 0 },
      notes: [
        "Не разобрал перемещение. Напиши маршрутом и списком, например:",
        "Т10 на Т1: SO3206 12, PJ10440 2",
        "Т10 на Т2: BIO_2005 1"
      ]
    };
  }

  const routes = new Set(lines.map(line => `${line.from} → ${line.to}`));
  const outputPath = await writeReportWorkbook({
    fileName: `peremeshchenie-${createTimestamp()}`,
    sheetName: "Перемещение",
    outDir: request.outDir,
    columns: [
      { header: "Со склада", key: "from", width: 12 },
      { header: "На склад", key: "to", width: 12 },
      { header: "Артикул", key: "sku", width: 20 },
      { header: "Кол-во", key: "qty", width: 10 },
      { header: "Магазин-источник", key: "fromName", width: 30 },
      { header: "Магазин-получатель", key: "toName", width: 30 }
    ],
    rows: lines.map(line => ({
      from: line.from,
      to: line.to,
      sku: line.sku,
      qty: line.qty === null ? "" : line.qty,
      fromName: pointName(line.from),
      toName: pointName(line.to)
    }))
  });

  return {
    status: "success",
    lines,
    outputPath,
    stats: {
      routes: routes.size,
      lines: lines.length,
      units: lines.reduce((sum, line) => sum + (line.qty || 0), 0)
    },
    notes: []
  };
}

/**
 * @param {TextTransferResult} result
 * @returns {string}
 */
export function formatTextTransferResult(result) {
  if (result.status !== "success") {
    return result.notes.join("\n");
  }

  const byRoute = new Map();

  for (const line of result.lines) {
    const key = `${line.from} → ${line.to}`;

    byRoute.set(key, (byRoute.get(key) || 0) + 1);
  }

  return [
    "Документ перемещения готов.",
    `Excel-файл: ${result.outputPath}`,
    `Маршрутов: ${result.stats.routes}, позиций: ${result.stats.lines}, ` +
      `единиц: ${result.stats.units}`,
    ...[...byRoute].map(([route, count]) => `  ${route}: ${count} поз.`)
  ].join("\n");
}

export default {
  buildTransferTemplate,
  buildTransferFromText,
  formatTemplateResult,
  formatTextTransferResult,
  hasTransferText,
  isTemplateRequest,
  parseTransferText
};
