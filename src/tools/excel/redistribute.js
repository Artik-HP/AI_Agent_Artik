import {
  createTimestamp,
  keepFreshestPointRecords,
  normalizeInput,
  resolveFiles
} from "./shared.js";
import { writeReportWorkbook } from "./writer.js";
import { normalizeSkuKey, readReportFile } from "./deadStock.js";
import { normalizePointCode, pointName } from "./points.js";

/**
 * @typedef {Object} PointStock
 * @property {string} point
 * @property {string} sku
 * @property {string} name
 * @property {number} retail розничные продажи за период
 * @property {number} wholesale продажи покупателю за период
 * @property {number} end остаток на конец периода
 */

/**
 * @typedef {Object} MoveLine
 * @property {string} from
 * @property {string} to
 * @property {string} sku
 * @property {string} name
 * @property {number} qty
 * @property {number} sourceStock
 * @property {number} destSales
 * @property {number} share доля продаж получателя, 0..1
 */

/**
 * @typedef {Object} RedistributeResult
 * @property {"success"|"empty"|"needs_file"} status
 * @property {string[]} files
 * @property {MoveLine[]} lines
 * @property {string|null} outputPath
 * @property {Object} stats
 * @property {string[]} notes
 */

/**
 * Делит `total` целых единиц между получателями пропорционально весам.
 * Метод наибольших остатков: сумма результата всегда ровно `total`, поэтому
 * со склада уезжает ни больше ни меньше, чем там лежит.
 * @param {number} total
 * @param {number[]} weights
 * @returns {number[]}
 */
export function allocateProportionally(total, weights) {
  const sum = weights.reduce((acc, weight) => acc + Math.max(0, weight), 0);

  if (total <= 0 || sum <= 0) {
    return weights.map(() => 0);
  }

  const exact = weights.map(weight => (total * Math.max(0, weight)) / sum);
  const result = exact.map(Math.floor);
  let left = total - result.reduce((acc, value) => acc + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .filter(item => weights[item.index] > 0)
    .sort((first, second) =>
      second.fraction - first.fraction || first.index - second.index
    );

  for (let i = 0; left > 0 && i < order.length; i += 1) {
    result[order[i].index] += 1;
    left -= 1;
  }

  return result;
}

/**
 * Схлопывает строки одного товара на одном складе. Продажи складываются
 * (это движение за период), остаток берётся максимальный — это снимок на дату,
 * а не сумма. Нужно из-за пересекающихся выгрузок (один склад в двух файлах).
 * @param {import("./deadStock.js").DeadStockRecord[]} records
 * @returns {Map<string, Map<string, PointStock>>} sku -> point -> агрегат
 */
function groupBySkuAndPoint(records) {
  /** @type {Map<string, Map<string, PointStock>>} */
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

    // Ключ точки — канонический код, а не текст. Одна и та же Т1 приходит
    // и строкой-складом «Toppers 01 Lviv Gnatuka», и точкой из имени файла
    // «Т1 18.06-5.07», и без склейки считалась бы двумя магазинами: остаток
    // делился между ними, а в отчёт попадал маршрут «Т1 → Toppers 01».
    // Перенос по критериям делает ровно так же (transferByCriteria.js).
    const code = normalizePointCode(record.point) || record.point;
    const existing = points.get(code);

    if (!existing) {
      points.set(code, {
        point: code,
        sku: record.sku,
        name: record.name,
        retail: record.retail,
        wholesale: record.wholesale,
        end: record.end
      });
      continue;
    }

    existing.retail += record.retail;
    existing.wholesale += record.wholesale;
    existing.end = Math.max(existing.end, record.end);

    if (!existing.name && record.name) {
      existing.name = record.name;
    }
  }

  return bySku;
}

/**
 * @param {RedistributeResult} result
 * @param {string|null} outDir
 * @returns {Promise<string>}
 */
async function writeRedistributeWorkbook(result, outDir) {
  return await writeReportWorkbook({
    fileName: `peremeshchenie-po-prodazham-${createTimestamp()}`,
    sheetName: "Перемещение",
    outDir,
    columns: [
      { header: "Со склада", key: "from", width: 26 },
      { header: "На склад", key: "to", width: 26 },
      { header: "Артикул", key: "sku", width: 18 },
      { header: "Название", key: "name", width: 52 },
      { header: "Кол-во", key: "qty", width: 9 },
      { header: "Остаток источника", key: "sourceStock", width: 17 },
      { header: "Продажи получателя", key: "destSales", width: 18 },
      { header: "Доля получателя", key: "share", width: 15, numFmt: "0%" },
      { header: "Магазин-источник", key: "fromName", width: 30 },
      { header: "Магазин-получатель", key: "toName", width: 30 }
    ],
    rows: result.lines.map(line => ({
      from: line.from,
      to: line.to,
      sku: line.sku,
      name: line.name,
      qty: line.qty,
      sourceStock: line.sourceStock,
      destSales: line.destSales,
      share: line.share,
      fromName: line.fromName,
      toName: line.toName
    }))
  });
}

/**
 * Строит перемещение «оттуда, где не продаётся, туда, где продаётся».
 * Источник — склад, на котором за период не было ни розничных, ни оптовых
 * продаж, но остался остаток. Получатели — склады с розничными продажами;
 * остаток источника делится между ними пропорционально их продажам.
 * Артикулы, которые не продаются нигде, пропускаются.
 * @param {unknown} input
 * @returns {Promise<RedistributeResult>}
 */
export async function buildRedistribution(input) {
  const request = normalizeInput(input);
  const files = resolveFiles(request);

  if (files.length === 0) {
    return {
      status: "needs_file",
      files: [],
      lines: [],
      outputPath: null,
      stats: {},
      notes: [
        "Не нашёл отчёты о продажах. Отправь боту выгрузки по точкам (Т1, Т2, … Х2)."
      ]
    };
  }

  /** @type {import("./deadStock.js").DeadStockRecord[]} */
  const records = [];

  for (const file of files) {
    records.push(...readReportFile(file).records);
  }

  // Одна точка в нескольких выгрузках — это она же за другой период, а не
  // второй магазин: суммирование задваивало её продажи и остаток.
  const fresh = keepFreshestPointRecords(records, files);
  const bySku = groupBySkuAndPoint(fresh.records);
  /** @type {MoveLine[]} */
  const lines = [];
  const points = new Set();
  let deadEverywhere = 0;
  let sourcesWithStock = 0;

  for (const pointMap of bySku.values()) {
    const stocks = [...pointMap.values()];

    stocks.forEach(stock => points.add(stock.point));

    const sources = stocks.filter(
      stock => stock.retail === 0 && stock.wholesale === 0 && stock.end > 0
    );

    if (sources.length === 0) {
      continue;
    }

    const destinations = stocks.filter(stock => stock.retail > 0);

    if (destinations.length === 0) {
      deadEverywhere += 1;
      continue;
    }

    const salesTotal = destinations.reduce((sum, stock) => sum + stock.retail, 0);

    for (const source of sources) {
      const units = Math.floor(source.end);

      if (units < 1) {
        continue;
      }

      sourcesWithStock += 1;

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
          from: source.point,
          to: destination.point,
          sku: source.sku,
          name: source.name || destination.name,
          qty,
          sourceStock: source.end,
          destSales: destination.retail,
          share: salesTotal > 0 ? destination.retail / salesTotal : 0,
          fromName: pointName(source.point),
          toName: pointName(destination.point)
        });
      });
    }
  }

  lines.sort((first, second) =>
    first.sku.localeCompare(second.sku) ||
    first.from.localeCompare(second.from) ||
    first.to.localeCompare(second.to)
  );

  const stats = {
    filesRead: files.length,
    points: points.size,
    skus: bySku.size,
    sourcesWithStock,
    moves: lines.length,
    units: lines.reduce((sum, line) => sum + line.qty, 0),
    deadEverywhere
  };

  /** @type {RedistributeResult} */
  const result = {
    status: lines.length > 0 ? "success" : "empty",
    files,
    lines,
    outputPath: null,
    stats,
    notes: []
  };

  if (lines.length === 0) {
    result.notes.push(
      "Нечего перемещать: либо везде есть продажи, либо мёртвые остатки не продаются ни на одной точке."
    );

    return result;
  }

  result.outputPath = await writeRedistributeWorkbook(result, request.outDir);

  return result;
}

/**
 * @param {RedistributeResult} result
 * @returns {string}
 */
export function formatRedistributeResult(result) {
  if (result.status === "needs_file") {
    return result.notes.join("\n");
  }

  if (result.status === "empty") {
    return ["Перемещение не собрано.", ...result.notes].join("\n");
  }

  const stats = result.stats;

  return [
    "Перемещение по нулевым продажам готово.",
    `Excel-файл: ${result.outputPath}`,
    `Файлов: ${stats.filesRead}, складов: ${stats.points}, артикулов: ${stats.skus}`,
    `Мёртвых остатков к вывозу: ${stats.sourcesWithStock}`,
    `Строк перемещения: ${stats.moves}, единиц: ${stats.units}`,
    `Пропущено (не продаётся нигде): ${stats.deadEverywhere} артикулов`,
    "Остаток источника делится между получателями пропорционально их продажам."
  ].join("\n");
}

export default {
  run: async input => formatRedistributeResult(await buildRedistribution(input))
};
