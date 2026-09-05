import fs from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";

import {
  createTimestamp,
  normalizeInput,
  OUTPUT_DIR,
  resolveFiles
} from "./shared.js";
import {
  readSheetMatrices,
  resolveProjectPath,
  toProjectPath
} from "./reader.js";
import { normalizePointCode } from "./points.js";

/**
 * Операции над листами книги: посмотреть, создать, удалить, переименовать,
 * скопировать.
 *
 * Исходный файл НЕ меняется. Книга читается, правится в памяти и пишется новым
 * файлом в `exports/`: удаление листа необратимо, а исходник — то, что человек
 * прислал боту, и второй попытки у него не будет. Заодно результат сразу
 * уезжает пользователю: Telegram отправляет файл по строке «Excel-файл: …».
 */

/**
 * @typedef {Object} SheetOperation
 * @property {"list"|"create"|"delete"|"rename"|"copy"} kind
 * @property {string} [name] лист, к которому применяем
 * @property {string} [target] новое имя (для rename/copy)
 */

/**
 * @typedef {Object} SheetsResult
 * @property {"success"|"list"|"empty"|"needs_file"|"needs_operation"} status
 * @property {string} file исходный файл
 * @property {string[]} before листы до правки
 * @property {string[]} after листы после правки
 * @property {string[]} applied
 * @property {{ text: string, reason: string }[]} skipped
 * @property {string|null} outputPath
 * @property {string[]} notes
 */

/** Слово «лист» во всех падежах и на украинском. */
const SHEET_NOUN =
  /^(?:лист[\p{L}]*|аркуш[\p{L}]*|вкладк[\p{L}]*|sheets?)(?=[\s:"«'(]|$)\s*/iu;

/**
 * Слова между глаголом и словом «лист», которые ничего не значат:
 * «создай ещё один лист Т9».
 */
const FILLERS =
  /^(?:нов[\p{L}]+|пуст[\p{L}]+|ещ[её]|дополнительн[\p{L}]+|один|одну|мне|пожалуйста|там|в|из|у)(?=\s)\s*/iu;

/**
 * Глаголы операций. Порядок важен только для читаемости — совпадения
 * собираются по позиции в тексте.
 */
const OPERATIONS = [
  {
    kind: "rename",
    verb: /переименуй\w*|переименовать|перейменуй\w*|перейменувати|переназови/giu
  },
  {
    kind: "copy",
    verb: /скопируй|скопировать|копируй|продублируй|дублируй|продублюй|скопіюй/giu
  },
  {
    kind: "create",
    verb: /создай\w*|создать|добавь\w*|добавить|заведи|створи\w*|додай|додати/giu
  },
  {
    kind: "delete",
    verb: /удали\w*|удалить|убери\w*|убрать|снеси|видали\w*|видалити|прибери/giu
  }
];

/** Разделитель «старое → новое» в переименовании и копировании. */
const RENAME_SEPARATOR = /\s+(?:в|на|как|у|to|->|=>|→)\s+/iu;

/** Запрос списка листов: «какие листы», «покажи листы», «сколько вкладок». */
const LIST_INTENT =
  /(?:как[иі]е|показ\w*|покажи|спис[оі]к|перечисл\w*|сколько|скільки|что за|які)\s+[^.]{0,20}?(?:лист|аркуш|вкладк|sheet)/iu;

/**
 * Убирает из текста пути к таблицам: иначе «создай лист Т9 data/t1.xlsx»
 * назовёт лист вместе с путём.
 * @param {string} text
 * @returns {string}
 */
function stripFilePaths(text) {
  return String(text || "").replace(/\S+\.(?:xlsx|xlsm|xls|csv)\b/giu, " ");
}

/**
 * Режет перечисление имён: «Т5, Т6 и Т7» → ["Т5", "Т6", "Т7"]. Имя в кавычках
 * приоритетнее — в нём могут быть и запятые, и слово «и».
 * @param {string} text
 * @returns {string[]}
 */
function splitNames(text) {
  const source = String(text || "").trim();
  const quoted = [...source.matchAll(/[«"']([^«»"']+)[»"']/gu)].map(item =>
    item[1].trim()
  );

  if (quoted.length > 0) {
    return quoted.filter(Boolean);
  }

  return source
    .split(/\s*[,;]\s*|\s+и\s+|\s+та\s+/iu)
    .map(name =>
      name
        .replace(/^[\s:—-]+|[\s.,;:!?]+$/gu, "")
        // «удали лист Т5 и создай лист Т9»: союз повис в конце имени, потому
        // что за ним сразу начинается следующая операция.
        .replace(/\s+(?:и|та|and)$/iu, "")
        .trim()
    )
    .filter(Boolean);
}

/**
 * Разбирает запрос в список операций. Глагол засчитывается за операцию только
 * если сразу за ним идёт слово «лист» — иначе «удали всё кроме pjur» стало бы
 * удалением листа.
 * @param {string} query
 * @returns {SheetOperation[]}
 */
export function parseSheetOperations(query) {
  const text = stripFilePaths(query);
  /** @type {{ index: number, end: number, kind: string }[]} */
  const hits = [];

  for (const operation of OPERATIONS) {
    operation.verb.lastIndex = 0;

    for (const match of text.matchAll(operation.verb)) {
      hits.push({
        index: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        kind: operation.kind
      });
    }
  }

  hits.sort((first, second) => first.index - second.index);

  /** @type {SheetOperation[]} */
  const operations = [];

  hits.forEach((hit, order) => {
    const next = hits[order + 1];
    let rest = text.slice(hit.end, next ? next.index : text.length).trim();

    // «создай ещё один лист Т9» — мусор между глаголом и существительным.
    while (FILLERS.test(rest)) {
      rest = rest.replace(FILLERS, "");
    }

    if (!SHEET_NOUN.test(rest)) {
      return;
    }

    rest = rest.replace(SHEET_NOUN, "").trim();

    if (hit.kind === "rename" || hit.kind === "copy") {
      const parts = rest.split(RENAME_SEPARATOR);
      const name = splitNames(parts[0])[0];

      if (!name) {
        return;
      }

      operations.push({
        kind: /** @type {"rename"|"copy"} */ (hit.kind),
        name,
        target: parts[1] ? splitNames(parts[1])[0] : undefined
      });

      return;
    }

    for (const name of splitNames(rest)) {
      operations.push({
        kind: /** @type {"create"|"delete"} */ (hit.kind),
        name
      });
    }
  });

  if (operations.length === 0 && LIST_INTENT.test(text)) {
    operations.push({ kind: "list" });
  }

  return operations;
}

/**
 * Есть ли в запросе намерение поработать с листами. Нужно роутеру
 * [excelTool.js](./excelTool.js).
 * @param {string} query
 * @returns {boolean}
 */
export function hasSheetIntent(query) {
  return parseSheetOperations(query).length > 0;
}

/**
 * Точное совпадение имени листа, без учёта регистра и лишних пробелов.
 *
 * Именно этой строгой проверкой решается «занято ли имя»: нечёткий поиск ниже
 * считает «з Т06» и «з т6» одной точкой, и переименование «з т6» → «з Т06»
 * падало бы с «такой лист уже есть».
 * @param {ExcelJS.Workbook} workbook
 * @param {string} name
 * @returns {ExcelJS.Worksheet|null}
 */
function findSheetExact(workbook, name) {
  const wanted = String(name || "").trim().toLowerCase();

  if (!wanted) {
    return null;
  }

  return workbook.worksheets.find(
    sheet => sheet.name.trim().toLowerCase() === wanted
  ) || null;
}

/**
 * Ищет лист, над которым работаем: сначала точно, затем через реестр точек —
 * чтобы «удали лист т5» нашёл лист, названный «з т5». Неоднозначность (два
 * листа с одним кодом точки) не разрешаем: молча удалить не тот лист хуже,
 * чем переспросить.
 * @param {ExcelJS.Workbook} workbook
 * @param {string} name
 * @returns {ExcelJS.Worksheet|null}
 */
function findSheet(workbook, name) {
  const exact = findSheetExact(workbook, name);

  if (exact) {
    return exact;
  }

  const code = normalizePointCode(name);

  if (!code) {
    return null;
  }

  const byPoint = workbook.worksheets.filter(
    sheet => normalizePointCode(sheet.name) === code
  );

  return byPoint.length === 1 ? byPoint[0] : null;
}

/**
 * Копирует лист вместе со значениями, стилями, ширинами колонок и объединёнными
 * ячейками. В ExcelJS готового «дублировать лист» нет.
 * @param {ExcelJS.Workbook} workbook
 * @param {ExcelJS.Worksheet} source
 * @param {string} name
 * @returns {ExcelJS.Worksheet}
 */
function copyWorksheet(workbook, source, name) {
  const target = workbook.addWorksheet(name);

  source.columns?.forEach((column, index) => {
    if (column?.width) {
      target.getColumn(index + 1).width = column.width;
    }
  });

  source.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const copy = target.getRow(rowNumber);

    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const cellCopy = copy.getCell(colNumber);

      cellCopy.value = cell.value;
      cellCopy.style = cell.style;
    });

    if (row.height) {
      copy.height = row.height;
    }
  });

  for (const range of source.model?.merges || []) {
    try {
      target.mergeCells(range);
    } catch {
      // Диапазон уже занят — пропускаем, значения уже скопированы.
    }
  }

  return target;
}

/**
 * Применяет одну операцию к книге.
 * @param {ExcelJS.Workbook} workbook
 * @param {SheetOperation} operation
 * @returns {{ ok: boolean, text: string, reason?: string }}
 */
function applyOperation(workbook, operation) {
  if (operation.kind === "list") {
    return { ok: true, text: "показан список листов" };
  }

  const label = operation.name ? `«${operation.name}»` : "лист";

  if (operation.kind === "create") {
    if (findSheetExact(workbook, operation.name)) {
      return { ok: false, text: label, reason: "такой лист уже есть" };
    }

    workbook.addWorksheet(operation.name);

    return { ok: true, text: `создан лист ${label}` };
  }

  const sheet = findSheet(workbook, operation.name);

  if (!sheet) {
    return { ok: false, text: label, reason: "лист не найден" };
  }

  if (operation.kind === "delete") {
    if (workbook.worksheets.length === 1) {
      return {
        ok: false,
        text: label,
        reason: "это последний лист книги, Excel не откроет файл без листов"
      };
    }

    workbook.removeWorksheet(sheet.id);

    return { ok: true, text: `удалён лист «${sheet.name}»` };
  }

  if (operation.kind === "rename") {
    if (!operation.target) {
      return { ok: false, text: label, reason: "не понял новое имя" };
    }

    if (findSheetExact(workbook, operation.target)) {
      return {
        ok: false,
        text: label,
        reason: `лист «${operation.target}» уже есть`
      };
    }

    const from = sheet.name;
    sheet.name = operation.target;

    return { ok: true, text: `лист «${from}» переименован в «${operation.target}»` };
  }

  // copy
  const target = operation.target || `${sheet.name} (2)`;

  if (findSheetExact(workbook, target)) {
    return { ok: false, text: label, reason: `лист «${target}» уже есть` };
  }

  copyWorksheet(workbook, sheet, target);

  return { ok: true, text: `лист «${sheet.name}» скопирован в «${target}»` };
}

/**
 * Список листов книги без её перезаписи. Отдельная ветка нужна потому, что
 * читать книгу для показа и открывать её для правки — разные по требованиям
 * задачи: показать можно почти любую книгу, а записать — только ту, что
 * ExcelJS сумел разобрать целиком.
 * @param {string} file путь как его назвал пользователь
 * @param {string} fullPath
 * @param {string[]} files все найденные книги
 * @param {SheetsResult} empty заготовка результата
 * @returns {SheetsResult}
 */
function listSheetsOnly(file, fullPath, files, empty) {
  /** @type {string[]} */
  const notes = [];

  if (files.length > 1) {
    notes.push(
      `Нашёл несколько книг, взял первую: ${file}.`,
      "Другую — назови файл в запросе."
    );
  }

  try {
    const names = readSheetMatrices(fullPath).map(sheet => sheet.name);

    return {
      ...empty,
      status: "list",
      file,
      before: names,
      after: names,
      applied: [`показаны листы: ${names.length}`],
      notes
    };
  } catch (error) {
    return {
      ...empty,
      status: "needs_file",
      file,
      notes: [
        `Не смог прочитать книгу ${file}.`,
        `Причина: ${error instanceof Error ? error.message : String(error)}`
      ]
    };
  }
}

/**
 * Управление листами книги.
 * @param {unknown} input
 * @returns {Promise<SheetsResult>}
 */
export async function manageSheets(input) {
  const request = normalizeInput(input);
  const operations = parseSheetOperations(request.query);
  const files = resolveFiles(request);

  /** @type {SheetsResult} */
  const empty = {
    status: "needs_file",
    file: "",
    before: [],
    after: [],
    applied: [],
    skipped: [],
    outputPath: null,
    notes: []
  };

  if (files.length === 0) {
    return {
      ...empty,
      notes: [
        "Не нашёл файл. Пришли книгу боту или укажи путь в запросе."
      ]
    };
  }

  if (operations.length === 0) {
    return {
      ...empty,
      status: "needs_operation",
      notes: [
        "Не понял, что сделать с листами. Например:",
        "• «покажи листы»",
        "• «создай лист Т9»",
        "• «удали листы Т5, Т6»",
        "• «переименуй лист Т5 в Т9»",
        "• «скопируй лист Т5 в Т9»"
      ]
    };
  }

  // Операции над листами всегда про одну книгу: «удали лист Т5» в пяти файлах
  // сразу — почти наверняка не то, что человек имел в виду.
  const file = files[0];

  // В пул файлов попадают CSV и старые .xls — у первых листов нет вообще,
  // вторые ExcelJS не читает. И там, и там вместо понятного объяснения
  // прилетала невнятная ошибка парсера.
  if (!/\.(?:xlsx|xlsm)$/i.test(file)) {
    return {
      ...empty,
      status: "needs_file",
      file,
      notes: [
        `Листы есть только у книг Excel, а ${file} — не книга.`,
        "Пришли .xlsx или укажи его путь в запросе."
      ]
    };
  }

  const fullPath = resolveProjectPath(file);
  // Показать листы можно и без ExcelJS: он спотыкается о книги с
  // картинками и чертежами (drawing.anchors), а такие выгрузки —
  // обычное дело. Раньше кнопка «Листы» на них падала исключением.
  const readOnly = operations.every(operation => operation.kind === "list");

  if (readOnly) {
    return listSheetsOnly(file, fullPath, files, empty);
  }

  const workbook = new ExcelJS.Workbook();

  try {
    await workbook.xlsx.readFile(fullPath);
  } catch (error) {
    return {
      ...empty,
      status: "needs_file",
      file,
      notes: [
        `Не смог открыть книгу ${file} для правки.`,
        "Скорее всего, внутри есть картинки, диаграммы или объекты, которые",
        "библиотека записи не читает. Пересохрани файл в Excel как .xlsx",
        "без картинок — и пришли снова.",
        `Причина: ${error instanceof Error ? error.message : String(error)}`
      ]
    };
  }

  const before = workbook.worksheets.map(sheet => sheet.name);
  /** @type {string[]} */
  const applied = [];
  /** @type {{ text: string, reason: string }[]} */
  const skipped = [];

  for (const operation of operations) {
    const outcome = applyOperation(workbook, operation);

    if (outcome.ok) {
      applied.push(outcome.text);
    } else {
      skipped.push({ text: outcome.text, reason: outcome.reason || "" });
    }
  }

  const after = workbook.worksheets.map(sheet => sheet.name);
  const changed = applied.some(text => !text.startsWith("показан"));
  /** @type {string[]} */
  const notes = [];

  if (files.length > 1) {
    notes.push(
      `Файлов нашлось ${files.length}, работаю с последним: ${toProjectPath(fullPath)}.`
    );
  }

  /** @type {SheetsResult} */
  const result = {
    status: changed ? "success" : operations.every(item => item.kind === "list")
      ? "list"
      : "empty",
    file: toProjectPath(fullPath),
    before,
    after,
    applied,
    skipped,
    outputPath: null,
    notes
  };

  if (!changed) {
    return result;
  }

  const outDir = request.outDir || OUTPUT_DIR;
  const outputPath = path.resolve(
    process.cwd(),
    outDir,
    `listy-${createTimestamp()}.xlsx`
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);

  result.outputPath = outputPath;

  return result;
}

/**
 * @param {SheetsResult} result
 * @returns {string}
 */
export function formatSheetsResult(result) {
  if (result.status === "needs_file" || result.status === "needs_operation") {
    return result.notes.join("\n");
  }

  const lines = [];

  if (result.status === "list") {
    lines.push(`Листы в файле ${result.file} (${result.before.length}):`);
    result.before.forEach((name, index) => {
      lines.push(`${index + 1}. ${name}`);
    });
  } else if (result.status === "success") {
    lines.push("Листы обновлены.");
    lines.push(`Excel-файл: ${result.outputPath}`);
    lines.push(`Источник: ${result.file} — не изменён.`);
    lines.push(`Было (${result.before.length}): ${result.before.join(", ")}`);
    lines.push(`Стало (${result.after.length}): ${result.after.join(", ")}`);
    lines.push("Сделано:");
    result.applied.forEach(text => lines.push(`- ${text}`));
  } else {
    lines.push("Ничего не изменил.");
    lines.push(`Листы в файле ${result.file}: ${result.before.join(", ")}`);
  }

  if (result.skipped.length > 0) {
    lines.push("Пропущено:");
    result.skipped.forEach(item => lines.push(`- ${item.text}: ${item.reason}`));
  }

  result.notes.forEach(note => lines.push(note));

  return lines.join("\n");
}

export default {
  run: async input => formatSheetsResult(await manageSheets(input))
};
