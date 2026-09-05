import {
  createTimestamp,
  normalizeInput,
  resolveFiles
} from "./shared.js";
import { writeReportWorkbook } from "./writer.js";
import {
  normalizeHeader,
  readSheetMatrices,
  stripSpreadsheetPaths,
  resolveProjectPath,
  sheetPointName,
  toProjectPath
} from "./reader.js";

/**
 * Тексты, по которым ищем колонку с названием товара. Заголовок «съезжает»
 * между выгрузками, поэтому колонку определяем по названию, а не по индексу.
 */
const NAME_LABELS = [
  "наименование",
  "название",
  "номенклатура найменування",
  "найменування",
  "назва",
  "товар",
  "product name",
  "product",
  "name",
  "item"
].map(normalizeHeader);

/** Признак того, что колонка — это артикул/штрихкод, а не название. */
const ARTICLE_HINT = /артикул|штрих|barcode|\bsku\b|\bean\b|\bкод\b/;

/** Команды, которые отрезаем из запроса, чтобы осталась только искомая строка. */
const COMMAND_PREFIXES = new RegExp(
  "^\\s*(?:" +
    "удали(?:ть)?\\s+(?:вс[её]|все)\\s+кроме|" +
    "видали(?:ти)?\\s+вс[еі]\\s+кр[іи]м|" +
    "остав(?:ь|ить|и)(?:\\s+(?:тольк[ои]|лишь))?|" +
    "залиши(?:ти)?(?:\\s+тільки)?|" +
    "keep\\s+only|" +
    "тольк[ои]|лишь|тільки|only" +
  ")(?:\\s+|$)",
  "i"
);

/**
 * @typedef {Object} FilterResult
 * @property {"success"|"empty"|"needs_query"|"needs_file"} status
 * @property {string} phrase искомая подстрока
 * @property {string[]} files
 * @property {string|null} outputPath
 * @property {{ scanned: number, kept: number, skippedFiles: string[] }} stats
 * @property {string[]} notes
 */

/**
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
  return normalizeHeader(text)
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9а-яёіїєґ-]/gi, "")
    .slice(0, 24) || "filter";
}

/**
 * Из «оставь только pjur data/t1.xlsx» достаёт «pjur».
 * @param {string} query
 * @returns {string}
 */
export function extractKeepPhrase(query) {
  // Путь вырезаем ПЕРВЫМ и общим разбором: он умеет пути с пробелами,
  // а прежний `\S+\.xlsx` обрывался на первом пробеле и оставлял хвост
  // пути внутри фразы. Кавычки снимаем уже после — им до этого момента
  // ещё нужно было отделять путь от слов.
  let text = stripSpreadsheetPaths(
    String(query || "").replace(/^\s*\/excel\b/i, "")
  )
    .replace(/["'«»]/g, "")
    .trim();

  // Команду отрезаем повторно: «оставь только X» может прийти как два токена.
  for (let pass = 0; pass < 2; pass += 1) {
    text = text.replace(COMMAND_PREFIXES, "").trim();
  }

  return text
    .replace(/\b(?:в|из|со|с)\s+файл\w*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Индекс колонки с названием товара. Заголовок собираем из первых строк —
 * в выгрузках BAS он расщеплён на «Місце зберігання» / «Номенклатура.Найменування».
 * @param {unknown[][]} rows
 * @returns {number}
 */
function findNameColumn(rows) {
  const probe = [rows[0] || [], rows[1] || []];
  const width = probe.reduce((max, row) => Math.max(max, row.length), 0);
  let bestIndex = -1;
  let bestScore = 0;

  for (let column = 0; column < width; column += 1) {
    const header = normalizeHeader(
      probe.map(row => row[column] ?? "").join(" ")
    );

    if (!header) {
      continue;
    }

    let score = 0;

    for (const label of NAME_LABELS) {
      if (header === label) {
        score = Math.max(score, 4);
      } else if (header.includes(label)) {
        score = Math.max(score, 3);
      }
    }

    // «Номенклатура.Артикул» тоже ловит name-метки — гасим такие колонки.
    if (score > 0 && ARTICLE_HINT.test(header)) {
      score -= 2;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIndex = column;
    }
  }

  return bestScore > 0 ? bestIndex : -1;
}

/**
 * @typedef {Object} FilterSheet
 * @property {string|null} point имя вкладки как точка, null если вкладка одна
 * @property {string[]} headers
 * @property {number} nameIndex
 * @property {unknown[][]} dataRows
 */

/**
 * Читает все вкладки книги: шапка и колонка названия ищутся в каждой отдельно,
 * раскладка у вкладок разная.
 * @param {string} filePath
 * @returns {FilterSheet[]}
 */
function readSheets(filePath) {
  const sheets = readSheetMatrices(filePath);

  return sheets.map(sheet => {
    const rows = sheet.rows;
    const headerRow = Array.isArray(rows[0]) ? rows[0] : [];
    const secondRow = Array.isArray(rows[1]) ? rows[1] : [];
    const width = Math.max(headerRow.length, secondRow.length);
    const headers = [];

    for (let column = 0; column < width; column += 1) {
      const primary = String(headerRow[column] ?? "").trim();
      const secondary = String(secondRow[column] ?? "").trim();
      headers.push(primary || secondary || `Колонка ${column + 1}`);
    }

    return {
      point: sheetPointName(sheet.name, sheets.length),
      headers,
      nameIndex: findNameColumn(rows),
      dataRows: rows.slice(1).map(row => (Array.isArray(row) ? row : []))
    };
  });
}

/**
 * @param {FilterResult} result
 * @param {{ headers: string[] }[]} sources
 * @param {{ file: string, cells: Record<string, string> }[]} kept
 * @param {string|null} outDir
 * @returns {Promise<string>}
 */
async function writeFilteredWorkbook(result, sources, kept, outDir) {
  const union = [];
  const seen = new Set();

  for (const source of sources) {
    for (const header of source.headers) {
      const key = normalizeHeader(header);

      if (!seen.has(key)) {
        seen.add(key);
        union.push(header);
      }
    }
  }

  const headers = sources.length > 1 ? ["Файл", ...union] : union;

  return await writeReportWorkbook({
    fileName: `filter-${slugify(result.phrase)}-${createTimestamp()}`,
    sheetName: "Отфильтровано",
    outDir,
    columns: headers.map(header => ({
      header,
      width: header.length > 24 ? 40 : 16
    })),
    rows: kept.map(entry => {
      /** @type {Record<string, unknown>} */
      const row = sources.length > 1 ? { "Файл": entry.file } : {};

      for (const header of union) {
        row[header] = entry.cells[header] ?? "";
      }

      return row;
    })
  });
}

/**
 * Оставляет только строки, где в колонке названия есть искомая подстрока
 * (без учёта регистра), и пишет их в новый Excel. Остальное «удаляется».
 * @param {unknown} input
 * @returns {Promise<FilterResult>}
 */
export async function filterRowsByName(input) {
  const request = normalizeInput(input);
  const phrase = extractKeepPhrase(request.query);

  if (!phrase) {
    return {
      status: "needs_query",
      phrase: "",
      files: [],
      outputPath: null,
      stats: { scanned: 0, kept: 0, skippedFiles: [] },
      notes: [
        "Напиши, какое название оставить. Пример: оставь только pjur"
      ]
    };
  }

  const files = resolveFiles(request);

  if (files.length === 0) {
    return {
      status: "needs_file",
      phrase,
      files: [],
      outputPath: null,
      stats: { scanned: 0, kept: 0, skippedFiles: [] },
      notes: [
        "Не нашёл Excel-файл. Укажи путь или отправь файл боту в Telegram."
      ]
    };
  }

  const needle = normalizeHeader(phrase);
  /** @type {{ file: string, headers: string[], nameIndex: number }[]} */
  const sources = [];
  /** @type {{ file: string, cells: Record<string, string> }[]} */
  const kept = [];
  const skippedFiles = [];
  let scanned = 0;

  for (const file of files) {
    const fileName = toProjectPath(resolveProjectPath(file)).split("/").pop() || file;
    const sheets = readSheets(file);
    // Вкладка без колонки названия — не повод бросать всю книгу: остальные
    // вкладки могут быть нормальными. Пропускаем файл, только если непригодны все.
    const usable = sheets.filter(sheet => sheet.nameIndex !== -1);

    if (usable.length === 0) {
      skippedFiles.push(fileName);
      continue;
    }

    for (const sheet of usable) {
      const origin = sheet.point ? `${fileName} / ${sheet.point}` : fileName;

      sources.push({
        file: origin,
        headers: sheet.headers,
        nameIndex: sheet.nameIndex
      });

      for (const row of sheet.dataRows) {
        scanned += 1;

        const name = normalizeHeader(row[sheet.nameIndex] ?? "");

        if (!name || !name.includes(needle)) {
          continue;
        }

        /** @type {Record<string, string>} */
        const cells = {};
        sheet.headers.forEach((header, index) => {
          cells[header] = String(row[index] ?? "").trim();
        });

        kept.push({ file: origin, cells });
      }
    }
  }

  /** @type {FilterResult} */
  const result = {
    status: kept.length > 0 ? "success" : "empty",
    phrase,
    files,
    outputPath: null,
    stats: { scanned, kept: kept.length, skippedFiles },
    notes: []
  };

  if (skippedFiles.length > 0) {
    result.notes.push(
      `Пропустил (не нашёл колонку с названием): ${skippedFiles.join(", ")}`
    );
  }

  if (kept.length === 0) {
    result.notes.push(`Ни одной строки с «${phrase}» в названии не нашлось.`);

    return result;
  }

  result.outputPath = await writeFilteredWorkbook(
    result,
    sources,
    kept,
    request.outDir
  );

  return result;
}

/**
 * @param {FilterResult} result
 * @returns {string}
 */
export function formatFilterResult(result) {
  if (result.status === "needs_query" || result.status === "needs_file") {
    return result.notes.join("\n");
  }

  if (result.status === "empty") {
    return ["Фильтр не дал строк.", ...result.notes].join("\n");
  }

  return [
    `Оставил только строки с «${result.phrase}» в названии.`,
    `Excel-файл: ${result.outputPath}`,
    `Просмотрено строк: ${result.stats.scanned}`,
    `Оставлено строк: ${result.stats.kept}`,
    ...result.notes
  ].join("\n");
}

export default {
  run: async input => formatFilterResult(await filterRowsByName(input))
};
