import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { manageSheets } from "../src/tools/excel/sheets.js";
import { runExcelTool } from "../src/tools/excel/excelTool.js";

test("sheet operations use the latest upload unless a file is explicit", async () => {
  const root = path.resolve("test");
  const dir = fs.mkdtempSync(path.join(root, ".tmp-review-sheets-"));
  try {
    const oldFile = path.join(dir, "old.xlsx");
    const newFile = path.join(dir, "new.xlsx");
    for (const [file, name] of [[oldFile, "Old"], [newFile, "New"]]) {
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet(name).addRow(["Артикул"]);
      await workbook.xlsx.writeFile(file);
    }
    const memories = [oldFile, newFile].map(file => `Excel файл загружен: ${file}`);
    const listed = await manageSheets({ query: "покажи листы", memories });
    assert.equal(listed.file, newFile);
    assert.deepEqual(listed.before, ["New"]);
    const explicit = await manageSheets({ query: `покажи листы ${oldFile}`, memories });
    assert.equal(explicit.file, oldFile);
    const supplied = await manageSheets({ query: "покажи листы", memories, files: [oldFile] });
    assert.equal(supplied.file, oldFile);
    const changed = await manageSheets({ query: "создай лист Т9", memories, outDir: dir });
    const output = new ExcelJS.Workbook();
    await output.xlsx.readFile(changed.outputPath);
    assert.deepEqual(output.worksheets.map(sheet => sheet.name), ["New", "Т9"]);
    const original = new ExcelJS.Workbook();
    await original.xlsx.readFile(newFile);
    assert.deepEqual(original.worksheets.map(sheet => sheet.name), ["New"]);
    assert.deepEqual(memories, [oldFile, newFile].map(file => `Excel файл загружен: ${file}`));
  } finally {
    assert.ok(fs.realpathSync(dir).startsWith(root + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("documented product search ignores the trailing table instruction", async () => {
  const root = path.resolve("test");
  const dir = fs.mkdtempSync(path.join(root, ".tmp-review-search-"));
  try {
    const file = path.join(dir, "товары с пробелами.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Товары");
    sheet.addRow(["Артикул", "Название"]);
    sheet.addRow(["PJ10050", "Тестовый товар"]);
    await workbook.xlsx.writeFile(file);
    for (const query of ["найди PJ10050 в таблице", "найди PJ10050 в таблице.", "найди PJ10050", "поиск Тестовый товар"]) {
      const answer = await runExcelTool({ query, memories: [`Excel файл загружен: ${file}`] });
      assert.match(answer, /Найдено строк: 1/, query);
      assert.match(answer, /PJ10050/);
    }
    const explicit = await runExcelTool({ query: `/excel найди PJ10050 в таблице ${file}` });
    assert.match(explicit, /Найдено строк: 1/);
    const missing = await runExcelTool({ query: `найди ABSENT в таблице ${file}` });
    assert.equal(missing, "В таблицах ничего не найдено.");
  } finally {
    assert.ok(fs.realpathSync(dir).startsWith(root + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
