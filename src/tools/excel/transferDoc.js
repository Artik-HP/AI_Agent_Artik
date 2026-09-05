import xlsx from "xlsx";

import {
  createTimestamp,
  normalizeInput,
  resolveFiles
} from "./shared.js";
import { writeReportWorkbook } from "./writer.js";
import {
  resolveProjectPath,
  toProjectPath
} from "./reader.js";
import { normalizePointCode } from "./points.js";

// Единая заглушка для обеих колонок склада: лист «не знаю» у пользователя
// значит ровно это, и нечитаемый "?" рядом с ним смотрелся чужеродно.
const UNKNOWN_LOCATION = "не знаю";

/**
 * @typedef {Object} TransferLine
 * @property {string} from склад-источник
 * @property {string} to склад-получатель (имя листа)
 * @property {string} sku
 * @property {number|null} qty количество из строки, null — не указано
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
 * @property {{ sheets: number, lines: number, units: number, withQty: number, byRoute: Record<string, { lines: number, units: number }> }} stats
 * @property {string[]} notes
 */

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
    const text = fromName[1].trim();

    return normalizePointCode(text) || text;
  }

  // «переміщення на Т1_з Т2_з Т7»: в имени назван ПОЛУЧАТЕЛЬ, а источники
  // разложены по листам. findStoreCode взял бы первый код в имени — то есть
  // получателя — и подписал бы им колонку «Со склада».
  if (/(?<![\p{L}\d])на\s+\p{L}\s*\d{1,3}/iu.test(base)) {
    return UNKNOWN_LOCATION;
  }

  // Имя вида «переміщення з Т11» — не единственное: файл могли переименовать в
  // «t11.xlsx» или «Т5 перемещение.xlsx». Раньше всё это молча давало "?".
  return findStoreCode(base) || UNKNOWN_LOCATION;
}

/**
 * Имя листа → маршрут «откуда → куда». Книги приходят в трёх видах, и все три
 * настоящие, из рабочих файлов:
 *   «Т10 на Т1», «т10 на т9» — и источник, и получатель прямо в имени листа;
 *   «на Т9», «Т1», «т8»      — только получатель, источник в имени файла;
 *   «з т7», «с Т2»           — только ИСТОЧНИК: получатель тогда назван в имени
 *                              файла («переміщення на Т1_з Т2_з Т7»).
 * Раньше имя листа целиком считалось получателем, поэтому «т10 на Т1» уезжало
 * в отчёт складом с таким именем, а «з т7» — получателем вместо источника.
 *
 * «не знаю» кодом не становится и остаётся текстом: это осознанная пометка
 * человека, а не сбой разбора.
 * @param {string} sheetName
 * @returns {{ from: string|null, to: string|null }}
 */
function parseSheetRoute(sheetName) {
  const text = String(sheetName || "").trim().replace(/\s+/g, " ");

  if (!text) {
    return { from: null, to: null };
  }

  const pair = text.match(/^(.+?)\s+(?:на|to|->|→)\s+(.+)$/i);

  if (pair) {
    return {
      from: normalizePointCode(pair[1]),
      to: normalizePointCode(pair[2]) || pair[2].trim()
    };
  }

  if (/^(?:з|с|со|из|від|from)\s/i.test(text)) {
    return { from: normalizePointCode(text), to: null };
  }

  return { from: null, to: normalizePointCode(text) || text };
}

/**
 * Склад-получатель, названный в имени файла или в запросе. Нужен книгам, где
 * листы названы источниками: «переміщення на Т1_з Т2_з Т7» — все листы едут
 * на Т1, и в самой книге этого не написано нигде.
 * @param {string} query
 * @param {string} fileName
 * @returns {string|null}
 */
function resolveDestination(query, fileName) {
  const explicit = String(query || "").match(
    /(?:на\s*склад|получател[ья]|отримувач|destination)\s*[:=]?\s*(\p{L}\s*\d{1,3})/iu
  );

  if (explicit) {
    return normalizePointCode(explicit[1]);
  }

  const base = fileName.replace(/\.[^.]+$/, "").replace(/^\d{6,}-/, "");
  const named = base.match(
    /(?:перем[іи]щенн?[яе]|перенос|transfer)\s+на\s+(\p{L}\s*\d{1,3})/iu
  );

  return named ? normalizePointCode(named[1]) : null;
}

/**
 * Похоже ли значение на количество: целое или дробное число в отдельной
 * ячейке. Артикулы вроде «2031» тоже числа, поэтому количество ищется только
 * среди ячеек, которые артикулом уже не признаны.
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeQuantity(value) {
  return /^\d{1,4}(?:[.,]\d{1,3})?$/.test(String(value).trim());
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

  // Шапка «Артикул | Кількість» встречается не всегда, но когда встречается —
  // прошлый разбор записывал её отдельной позицией перемещения.
  if (/^(?:артикул|номенклатура|товар|назва|назван|код|sku)/i.test(cells[0])) {
    return null;
  }

  const skuIndex = cells.findIndex(looksLikeSku);
  const skuAt = skuIndex === -1 ? 0 : skuIndex;
  const sku = cells[skuAt];
  // Количество — соседнее число: в книгах со скриншота это колонка B рядом с
  // артикулом. Раньше оно уезжало в примечание, а колонка «Кол-во» уходила
  // пользователю пустой с советом заполнить руками.
  const qtyIndex = cells.findIndex(
    (cell, index) => index !== skuAt && looksLikeQuantity(cell)
  );
  const qty = qtyIndex === -1
    ? null
    : Number(cells[qtyIndex].replace(",", "."));
  const note = cells
    .filter((_, index) => index !== skuAt && index !== qtyIndex)
    .join("; ");

  return { sku, qty, note };
}

/**
 * Читает книгу перемещения. Маршрут строки собирается из двух источников:
 * имя листа знает больше (там бывает и «откуда», и «куда»), имя файла и запрос
 * закрывают то, чего в листе нет.
 * @param {string} filePath
 * @param {{ from: string, to: string|null }} fileRoute
 * @returns {TransferLine[]}
 */
function readTransferFile(filePath, fileRoute) {
  const workbook = xlsx.readFile(resolveProjectPath(filePath), { cellDates: true });
  /** @type {TransferLine[]} */
  const lines = [];

  for (const sheetName of workbook.SheetNames) {
    const route = parseSheetRoute(sheetName);
    const from = route.from || fileRoute.from || UNKNOWN_LOCATION;
    const to = route.to || fileRoute.to || UNKNOWN_LOCATION;
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
          qty: parsed.qty,
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
 * @param {TransferResult} result
 * @param {string|null} outDir
 * @returns {Promise<string>}
 */
async function writeTransferWorkbook(result, outDir) {
  return await writeReportWorkbook({
    fileName: `peremeshchenie-${createTimestamp()}`,
    sheetName: "Перемещение",
    outDir,
    columns: [
      { header: "Со склада", key: "from", width: 12 },
      { header: "На склад", key: "to", width: 14 },
      { header: "Артикул", key: "sku", width: 20 },
      { header: "Название", key: "name", width: 44 },
      { header: "Кол-во", key: "qty", width: 10 },
      { header: "Примечание", key: "note", width: 32 }
    ],
    rows: result.lines.map(line => ({
      from: line.from,
      to: line.to,
      sku: line.sku,
      name: "",
      qty: line.qty === null ? "" : line.qty,
      note: line.note
    }))
  });
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
      stats: { sheets: 0, lines: 0, units: 0, withQty: 0, byRoute: {} },
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
    const fileRoute = {
      from: resolveSource(request.query, fileName),
      to: resolveDestination(request.query, fileName)
    };

    from = fileRoute.from;

    for (const line of readTransferFile(file, fileRoute)) {
      lines.push(line);
      sheets.add(`${fileName}::${line.sheet}`);
    }
  }

  /** @type {Record<string, { lines: number, units: number }>} */
  const byRoute = {};
  for (const line of lines) {
    const key = `${line.from} → ${line.to}`;
    const route = byRoute[key] || { lines: 0, units: 0 };

    route.lines += 1;
    route.units += line.qty || 0;
    byRoute[key] = route;
  }

  // Источник в шапке ответа честен, только пока он один: книга «з Т2 / з Т7»
  // приезжает сразу с двух складов.
  const sources = [...new Set(lines.map(line => line.from))];

  if (sources.length === 1) {
    from = sources[0];
  } else if (sources.length > 1) {
    from = sources.join(", ");
  }

  /** @type {TransferResult} */
  const result = {
    status: lines.length > 0 ? "success" : "empty",
    from,
    files,
    lines,
    outputPath: null,
    stats: {
      sheets: sheets.size,
      lines: lines.length,
      units: lines.reduce((sum, line) => sum + (line.qty || 0), 0),
      withQty: lines.filter(line => line.qty !== null).length,
      byRoute
    },
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

  const stats = result.stats;
  const breakdown = Object.entries(stats.byRoute)
    .map(([route, count]) => count.units > 0
      ? `${route}: ${count.lines} поз., ${count.units} шт`
      : `${route}: ${count.lines} поз.`)
    .join("; ");

  return [
    "Документ перемещения готов.",
    `Excel-файл: ${result.outputPath}`,
    `Со склада: ${result.from}`,
    `Листов: ${stats.sheets}`,
    `Позиций всего: ${stats.lines}` +
      (stats.units > 0 ? `, единиц: ${stats.units}` : ""),
    `Маршруты: ${breakdown}`,
    stats.withQty === stats.lines && stats.lines > 0
      ? "Количества взяты из книги. Колонка «Название» пустая — заполни вручную."
      : `Количество нашлось у ${stats.withQty} из ${stats.lines} строк; ` +
        "остальные и колонку «Название» заполни вручную."
  ].join("\n");
}

export default {
  run: async input => formatTransferResult(await buildTransferDoc(input))
};
