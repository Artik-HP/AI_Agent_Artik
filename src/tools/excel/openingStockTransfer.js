import { NORMALIZED_MOVEMENT_LABELS } from "./columns.js";
import { normalizeSkuKey, readReportFile } from "./deadStock.js";
import {
  comparePointCodes,
  normalizePointCode,
  parseDestinationPoints,
  parseSourcePoints,
  pointName
} from "./points.js";
import { normalizeHeader } from "./reader.js";
import { parseNumber } from "./search.js";
import {
  createTimestamp,
  keepFreshestPointRecords,
  normalizeInput,
  resolveFiles
} from "./shared.js";
import { writeReportWorkbook } from "./writer.js";

/**
 * @typedef {Object} OpeningStockTransferResult
 * @property {"success"|"empty"|"needs_file"} status
 * @property {string[]} files
 * @property {Object[]} lines
 * @property {string|null} outputPath
 * @property {Object} stats
 * @property {string[]} sourcePoints
 * @property {string[]} destinationPoints
 * @property {boolean} strictBlanks
 * @property {string[]} notes
 */

/**
 * Отдельная команда: начальный запас без розничных продаж направляется
 * в магазины с явно пустой ячейкой «Конец» того же артикула.
 * @param {string} query
 * @returns {boolean}
 */
export function shouldTransferOpeningStock(query) {
  const text = normalizeHeader(query);
  const transfer = /(?:^|\s)(?:перен[ео]с|перемест|перемещ|переміст|переміщ|развез|розвез)[\p{L}]*/u.test(text);
  const opening = /(?:^|\s)(?:из|с|со|з|зі)\s+(?:(?:столбца|колонки|колонці|стовпця)\s+)?(?:начал[ао]|початку|початок)(?:\s|$)/u.test(text);

  const openingColumn = /(?:колонк[\p{L}]*|столб[\p{L}]*|стовп[\p{L}]*)\s*[«"']?(?:начало|початок)(?=[\s,.;:»"']|$)/u.test(text);

  return transfer && (opening || openingColumn);
}

/**
 * Числовые поля старого парсера не различают пустоту, ошибку и ноль.
 * Здесь читаем исходные ячейки и отдельно проверяем наличие заголовка.
 * @param {Record<string, string>} cells
 * @param {"start"|"receipt"|"retailSales"|"end"} field
 * @returns {{ missing: boolean, invalid: boolean, blank: boolean, value: number|null }}
 */
function readMovementCell(cells, field) {
  const exact = Object.entries(cells).filter(([header]) =>
    NORMALIZED_MOVEMENT_LABELS[field].includes(normalizeHeader(header))
  );
  const matches = exact.length > 0 ? exact : Object.entries(cells).filter(([header]) => {
    const normalized = normalizeHeader(header);

    return NORMALIZED_MOVEMENT_LABELS[field].some(label =>
      normalized === label || normalized.includes(label)
    );
  });

  if (matches.length !== 1) {
    return {
      missing: matches.length === 0,
      invalid: matches.length > 1,
      blank: false,
      value: null
    };
  }

  const raw = String(matches[0][1] ?? "").trim();

  if (!raw) {
    return { missing: false, invalid: false, blank: true, value: null };
  }

  // parseNumber удаляет текст; «ошибка 0» не должна становиться нулём продаж.
  const numeric = /^[+-]?(?:\d[\d\s.,]*|[.,]\d+)$/u.test(raw);
  const value = numeric ? parseNumber(raw) : null;

  return {
    missing: false,
    invalid: value === null,
    blank: false,
    value
  };
}

/**
 * Точные повторения не создают дополнительный запас. Отличающиеся строки
 * одной пары «артикул × точка» требуют проверки, а не сложения снимков.
 * @param {import("./deadStock.js").DeadStockRecord} record
 * @returns {string}
 */
function recordSignature(record) {
  return JSON.stringify(Object.entries(record.cells)
    .map(([header, value]) => [
      normalizeHeader(header),
      header === "Артикул" ? normalizeSkuKey(value) : String(value ?? "").trim()
    ])
    .sort((first, second) => first[0].localeCompare(second[0])));
}

/**
 * @param {OpeningStockTransferResult} result
 * @param {string|null} outDir
 * @returns {Promise<string>}
 */
async function writeOpeningStockWorkbook(result, outDir) {
  return await writeReportWorkbook({
    fileName: `peremeshchenie-iz-nachala-${createTimestamp()}`,
    sheetName: "Перемещение",
    outDir,
    columns: [
      { header: "Со склада", key: "from", width: 18 },
      { header: "На склад", key: "to", width: 18 },
      { header: "Артикул", key: "sku", width: 18 },
      { header: "Название", key: "name", width: 52 },
      { header: "Кол-во", key: "qty", width: 12 },
      { header: "Начало источника", key: "sourceStart", width: 20 },
      { header: "Конец источника", key: "sourceEnd", width: 20 },
      { header: "Розничные продажи источника", key: "sourceRetail", width: 28 },
      { header: "Конец получателя (пусто)", key: "destEnd", width: 26 },
      { header: "Магазин-источник", key: "fromName", width: 38 },
      { header: "Магазин-получатель", key: "toName", width: 38 }
    ],
    rows: result.lines
  });
}

/**
 * Создаёт план перемещения, сохраняя исходный отчёт. Приход не увеличивает
 * объём: берём целую часть min(Начало, Конец). Получатели определяются по
 * исходной таблице, затем весь объём артикула распределяется поровну.
 * @param {unknown} input
 * @returns {Promise<OpeningStockTransferResult>}
 */
export async function buildOpeningStockTransfer(input) {
  const request = normalizeInput(input);
  const files = resolveFiles(request);
  const sourcePoints = parseSourcePoints(request.query);
  const destinationPoints = parseDestinationPoints(request.query);
  // Упоминание прихода включает строгий отбор по заполненности. Старый
  // короткий режим «из начала» сохраняет прежнее правило пусто/0 продаж.
  const strictBlanks = /приход|прихід/iu.test(request.query);
  const result = {
    status: "needs_file",
    files,
    sourcePoints,
    destinationPoints,
    strictBlanks,
    lines: [],
    outputPath: null,
    stats: {
      filesRead: files.length,
      productRecords: 0,
      points: 0,
      skus: 0,
      sourcesWithStock: 0,
      noDestination: 0,
      moves: 0,
      units: 0,
      duplicateRows: 0,
      conflictingPairs: 0,
      missingColumns: 0,
      invalidValues: 0,
      skippedOldFiles: 0
    },
    notes: []
  };

  if (files.length === 0) {
    result.notes.push("Не нашёл отчёт движения товаров. Отправь Excel-файл с колонками «Начало», «Отчет о розничных продажах» и «Конец».");

    return result;
  }

  const records = files.flatMap(file => {
    const parsed = readReportFile(file);

    if (parsed.records.length === 0) {
      result.notes.push(`В файле ${file} не найдены товарные строки отчёта движения.`);
    }

    return parsed.records;
  });
  const fresh = keepFreshestPointRecords(records, files);
  const stats = result.stats;
  stats.productRecords = fresh.records.length;
  stats.skippedOldFiles = fresh.skipped.length;
  const bySku = new Map();
  const pointCodes = new Set();

  for (const record of fresh.records) {
    const sku = normalizeSkuKey(record.sku);
    const code = normalizePointCode(record.point) || String(record.point || "").trim();

    if (!sku || !code) {
      stats.invalidValues += 1;
      continue;
    }

    pointCodes.add(code);

    if (!bySku.has(sku)) {
      bySku.set(sku, new Map());
    }

    const points = bySku.get(sku);
    const signature = recordSignature(record);
    const existing = points.get(code);

    if (existing) {
      if (existing.signature === signature) {
        stats.duplicateRows += 1;
      } else {
        existing.conflict = true;
      }

      continue;
    }

    points.set(code, { code, record, signature, conflict: false });
  }

  const conflictExamples = [];
  const missingFields = new Set();

  for (const [, pointMap] of [...bySku].sort((first, second) => first[0].localeCompare(second[0]))) {
    const stocks = [];

    for (const entry of pointMap.values()) {
      if (entry.conflict) {
        stats.conflictingPairs += 1;

        if (conflictExamples.length < 5) {
          conflictExamples.push(`${entry.record.sku} / ${entry.code}`);
        }

        continue;
      }

      const start = readMovementCell(entry.record.cells, "start");
      const retail = readMovementCell(entry.record.cells, "retailSales");
      const end = readMovementCell(entry.record.cells, "end");
      const receipt = strictBlanks ? readMovementCell(entry.record.cells, "receipt") : null;
      const fields = [["Начало", start], ["Отчет о розничных продажах", retail], ["Конец", end]];
      if (strictBlanks) fields.push(["Приход", receipt]);

      if (fields.some(([, cell]) => cell.missing)) {
        stats.missingColumns += 1;
        fields.filter(([, cell]) => cell.missing).forEach(([name]) => missingFields.add(name));
        continue;
      }

      if (fields.some(([, cell]) => cell.invalid)) {
        stats.invalidValues += 1;
        continue;
      }

      stocks.push({ ...entry, start, retail, end, receipt });
    }

    const sources = stocks
      .filter(stock => (sourcePoints.length === 0 || sourcePoints.includes(stock.code)) &&
        stock.start.value > 0 && stock.end.value > 0 &&
        (strictBlanks
          ? stock.receipt.blank && stock.retail.blank
          : stock.retail.blank || stock.retail.value === 0))
      .sort((first, second) => comparePointCodes(first.code, second.code));
    const destinations = stocks
      .filter(stock => stock.end.blank &&
        (destinationPoints.length === 0 || destinationPoints.includes(stock.code)))
      .sort((first, second) => comparePointCodes(first.code, second.code));
    // Остаток округления передаётся следующему магазину. Указатель общий
    // для всех источников артикула: суммарная разница не превышает 1 шт.
    let nextRecipient = 0;

    for (const source of sources) {
      const units = Math.floor(Math.min(source.start.value, source.end.value));

      if (units < 1) {
        continue;
      }

      stats.sourcesWithStock += 1;

      if (destinations.length === 0) {
        stats.noDestination += 1;
        continue;
      }

      const quantities = destinations.map(() => Math.floor(units / destinations.length));
      const remainder = units % destinations.length;

      for (let offset = 0; offset < remainder; offset += 1) {
        quantities[(nextRecipient + offset) % destinations.length] += 1;
      }

      nextRecipient = (nextRecipient + remainder) % destinations.length;

      destinations.forEach((destination, index) => {
        if (quantities[index] === 0) {
          return;
        }

        result.lines.push({
          from: source.code,
          to: destination.code,
          sku: source.record.sku,
          name: source.record.name,
          qty: quantities[index],
          sourceStart: source.start.value,
          sourceEnd: source.end.value,
          sourceRetail: source.retail.value ?? (strictBlanks ? "" : 0),
          destEnd: "",
          fromName: pointName(source.code),
          toName: pointName(destination.code)
        });
      });
    }
  }

  stats.points = pointCodes.size;
  stats.skus = bySku.size;
  stats.moves = result.lines.length;
  stats.units = result.lines.reduce((total, line) => total + line.qty, 0);

  if (stats.missingColumns > 0) {
    result.notes.push(`Пропущено пар товар/магазин без обязательных колонок: ${stats.missingColumns}. Не найдены: ${[...missingFields].join(", ")}. Отсутствующая колонка не считается пустой ячейкой.`);
  }

  if (stats.invalidValues > 0) {
    result.notes.push(`Пропущено пар товар/магазин с некорректными значениями или неоднозначными заголовками: ${stats.invalidValues}.`);
  }

  if (stats.conflictingPairs > 0) {
    result.notes.push(`Пропущено пар товар/магазин с противоречивыми повторениями: ${stats.conflictingPairs} (${conflictExamples.join(", ")}). Проверь исходные строки.`);
  }

  if (stats.duplicateRows > 0) {
    result.notes.push(`Точные повторения строк учтены один раз: ${stats.duplicateRows}.`);
  }

  if (fresh.skipped.length > 0) {
    result.notes.push(`Для ${fresh.skipped.length} точек оставлена только самая свежая по времени файла выгрузка; более старые данные не складывались.`);
  }

  result.status = result.lines.length > 0 ? "success" : "empty";

  if (result.status === "empty") {
    result.notes.push("Не найдены пары: начальный запас без розничных продаж и другой магазин с явно пустым «Конец» у того же артикула.");

    return result;
  }

  result.outputPath = await writeOpeningStockWorkbook(result, request.outDir);

  return result;
}

/**
 * @param {OpeningStockTransferResult} result
 * @returns {string}
 */
export function formatOpeningStockTransferResult(result) {
  if (result.status === "needs_file") {
    return result.notes.join("\n");
  }

  const rules = [
    `Магазин-источник: ${result.sourcePoints.length > 0 ? result.sourcePoints.join(", ") : "все подходящие магазины"}.`,
    `Магазин-получатель: ${result.destinationPoints.length > 0 ? result.destinationPoints.join(", ") : "все магазины с пустым «Конец»"}.`,
    result.strictBlanks
      ? "Источник: «Начало» > 0, «Приход» и «Отчет о розничных продажах» строго пустые. Любая запись, включая 0, запрещает перенос. Количество — целая часть меньшего из «Начало» и «Конец»."
      : "Источник: «Начало» > 0, розничные продажи пусты или равны 0; количество — целая часть меньшего из «Начало» и «Конец».",
    "Получатель: у того же артикула есть строка с пустым «Конец». Числовой 0 и отсутствие строки не считаются пустой ячейкой.",
    "Товар распределяется поровну между подходящими магазинами; разница после округления — не более 1 шт. Дробный остаток остаётся у источника."
  ];

  if (result.status === "empty") {
    return ["Перемещение из начала не сформировано.", ...result.notes, ...rules].join("\n");
  }

  return [
    "План перемещения из начала без розничных продаж готов.",
    `Excel-файл: ${result.outputPath}`,
    `Файлов: ${result.stats.filesRead}, магазинов: ${result.stats.points}, артикулов: ${result.stats.skus}`,
    `Строк перемещения: ${result.stats.moves}, единиц: ${result.stats.units}`,
    `Источников без подходящего получателя: ${result.stats.noDestination}`,
    ...rules,
    "Исходная таблица сохранена; результат — отдельный план перемещения.",
    ...result.notes
  ].join("\n");
}

export default {
  run: async input => formatOpeningStockTransferResult(await buildOpeningStockTransfer(input))
};
