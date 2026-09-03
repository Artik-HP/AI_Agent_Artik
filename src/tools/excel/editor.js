import fs from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";

import {
  discoverSpreadsheetFiles,
  extractSpreadsheetPaths,
  loadWorkbooks,
  normalizeHeader,
  resolveProjectPath
} from "./reader.js";
import { askModel } from "../../model.js";

const BACKUP_DIR = "backups";

const EDIT_SYSTEM_PROMPT = `
Ты помощник, который превращает запрос пользователя на редактирование Excel/CSV в строгий JSON-план изменений.

Тебе дадут список файлов и их реальные заголовки колонок (уже нормализованные).
Верни ТОЛЬКО валидный JSON без пояснений и markdown, формата:

{
  "edits": [
    {
      "file": "относительный путь к файлу, ровно как в списке",
      "sheet": "название листа, ровно как в списке",
      "matchColumn": "заголовок колонки, по которой ищем строку (например 'артикул')",
      "matchValue": "значение, которое ищем в этой колонке",
      "setColumn": "заголовок колонки, которую меняем",
      "setValue": "новое значение"
    }
  ]
}

Правила:
- Используй ТОЛЬКО заголовки колонок из предоставленного списка.
- Если пользователь не указал, по какой колонке искать строку — выбери наиболее подходящую (артикул, sku, штрихкод).
- Если данных недостаточно, чтобы однозначно определить edit — верни {"edits": []}.
- Никогда не выдумывай файлы, листы или колонки, которых нет в списке.
`;

/**
 * @param {import("./reader.js").ExcelWorkbook[]} workbooks
 * @returns {string}
 */
function describeWorkbooksForModel(workbooks) {
  return workbooks
    .map(workbook => {
      const sheets = workbook.sheets
        .map(sheet => `  - Лист "${sheet.name}", колонки: ${sheet.headers.map(normalizeHeader).join(", ")}`)
        .join("\n");

      return `Файл: ${workbook.relativePath}\n${sheets}`;
    })
    .join("\n\n");
}

/**
 * @param {{ query: string, memories: string[] }} request
 * @returns {Promise<{ edits: object[] }>}
 */
export async function buildEditPlan(request) {
  const files = [
    ...extractSpreadsheetPaths(request.query),
    ...extractSpreadsheetPaths(request.memories.join("\n"))
  ];

  const targetFiles = files.length > 0 ? [...new Set(files)] : discoverSpreadsheetFiles();

  if (targetFiles.length === 0) {
    return { edits: [] };
  }

  const workbooks = loadWorkbooks(targetFiles);

  const response = await askModel([
    { role: "system", content: EDIT_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Запрос пользователя:\n${request.query}\n\nДоступные файлы:\n${describeWorkbooksForModel(workbooks)}`
    }
  ]);

  let plan;

  try {
    plan = JSON.parse(response);
  } catch {
    plan = { edits: [] };
  }

  return { edits: Array.isArray(plan.edits) ? plan.edits : [] };
}

/**
 * @param {ExcelJS.Worksheet} worksheet
 * @returns {Map<string, number>}
 */
function mapHeadersToColumns(worksheet) {
  const headerRow = worksheet.getRow(1);
  const map = new Map();

  headerRow.eachCell((cell, colNumber) => {
    if (cell.value) {
      map.set(normalizeHeader(String(cell.value)), colNumber);
    }
  });

  return map;
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function backupFile(filePath) {
  const backupDir = path.resolve(process.cwd(), BACKUP_DIR);
  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const backupPath = path.join(backupDir, `${path.basename(filePath)}.${timestamp}.bak`);

  fs.copyFileSync(filePath, backupPath);

  return backupPath;
}

/**
 * @typedef {{
 *   file?: string,
 *   sheet?: string,
 *   matchColumn?: string,
 *   matchValue?: string,
 *   setColumn?: string,
 *   setValue?: unknown,
 *   reason?: string
 * }} EditPlanItem
 */

/**
 * @typedef {{
 *   edit: EditPlanItem,
 *   rowsChanged: number,
 *   backupPath: string
 * }} AppliedEditResult
 */

/**
 * @typedef {{
 *   edit: EditPlanItem,
 *   reason: string
 * }} SkippedEditResult
 */

/**
 * @param {EditPlanItem[]} edits
 * @returns {Promise<{ applied: AppliedEditResult[], skipped: SkippedEditResult[] }>}
 */
export async function applyEditPlan(edits) {
  /** @type {AppliedEditResult[]} */
  const applied = [];
  /** @type {SkippedEditResult[]} */
  const skipped = [];
  const editsByFile = new Map();

  for (const edit of edits) {
    if (!edit.file || !edit.matchColumn || !edit.setColumn) {
      skipped.push({ edit, reason: "неполные данные в плане" });
      continue;
    }

    if (!editsByFile.has(edit.file)) {
      editsByFile.set(edit.file, []);
    }

    editsByFile.get(edit.file).push(edit);
  }

  for (const [file, fileEdits] of editsByFile) {
    let fullPath;

    try {
      fullPath = resolveProjectPath(file);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      for (const edit of fileEdits) skipped.push({ edit, reason: errorMessage });
      continue;
    }

    if (!fs.existsSync(fullPath)) {
      for (const edit of fileEdits) skipped.push({ edit, reason: "файл не найден" });
      continue;
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(fullPath);

    const backupPath = backupFile(fullPath);
    let changed = false;

    for (const edit of fileEdits) {
      const worksheet = edit.sheet
        ? workbook.getWorksheet(edit.sheet)
        : workbook.worksheets[0];

      if (!worksheet) {
        skipped.push({ edit, reason: `лист "${edit.sheet}" не найден` });
        continue;
      }

      const headerMap = mapHeadersToColumns(worksheet);
      const matchCol = headerMap.get(normalizeHeader(edit.matchColumn));
      const setCol = headerMap.get(normalizeHeader(edit.setColumn));

      if (!matchCol || !setCol) {
        skipped.push({ edit, reason: "колонка не найдена в файле" });
        continue;
      }

      let rowsChanged = 0;

      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;

        const cellValue = String(row.getCell(matchCol).value ?? "").trim();

        if (cellValue === String(edit.matchValue).trim()) {
          row.getCell(setCol).value = edit.setValue;
          rowsChanged++;
          changed = true;
        }
      });

      if (rowsChanged > 0) {
        applied.push({ edit, rowsChanged, backupPath });
      } else {
        skipped.push({ edit, reason: "совпадений не найдено" });
      }
    }

    if (changed) {
      await workbook.xlsx.writeFile(fullPath);
    }
  }

  return { applied, skipped };
}

/**
 * @param {{ applied: AppliedEditResult[], skipped: SkippedEditResult[] }} result
 * @returns {string}
 */
export function formatEditResult(result) {
  const lines = [];

  if (result.applied.length > 0) {
    lines.push("Изменено:");
    for (const item of result.applied) {
      lines.push(
        `- ${item.edit.file}: ${item.edit.matchColumn}="${item.edit.matchValue}" → ${item.edit.setColumn}="${item.edit.setValue}" (строк: ${item.rowsChanged})`
      );
    }
    lines.push(`\nБэкап: ${result.applied[0].backupPath}`);
  }

  if (result.skipped.length > 0) {
    lines.push("\nПропущено:");
    for (const item of result.skipped) {
      lines.push(`- ${JSON.stringify(item.edit)}: ${item.reason}`);
    }
  }

  if (result.applied.length === 0 && result.skipped.length === 0) {
    return "Не нашёл, что менять. Уточни файл, колонку-ориентир и значения.";
  }

  return lines.join("\n");
}

/**
 * @param {{ query: string, memories: string[] }} request
 * @returns {Promise<string>}
 */
export async function runEdit(request) {
  const { edits } = await buildEditPlan(request);

  if (edits.length === 0) {
    return "Не понял, что именно менять. Укажи файл, колонку-ориентир (например артикул) и что на что менять.";
  }

  const result = await applyEditPlan(edits);

  return formatEditResult(result);
}