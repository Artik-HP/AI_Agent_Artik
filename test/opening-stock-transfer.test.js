import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import Agent, { shouldUseExcelTool } from "../src/agent.js";
import { runExcelTool } from "../src/tools/excel/excelTool.js";
import {
  buildOpeningStockTransfer,
  shouldTransferOpeningStock
} from "../src/tools/excel/openingStockTransfer.js";
import { looksLikeSectionRow } from "../src/tools/excel/reader.js";

// Эти проверки не должны обращаться к базе из локального .env.
delete process.env.DATABASE_URL;

const HEADER = ["Місце зберігання", "", "Начало", "Приход", "Расход",
  "Отчет о розничных продажах", "Продажа покупателю", "Конец"];

const STRICT_QUERY = "Перемести товары с Т2 на другие магазины. условие перемещай товары только которые имеют запись в колонке начало, товары которые имеют запись в колонке приход и отчет о розничных продажах не переносить. товары переносить в те магазины где колонка конец пустая.";

test("strict opening transfer respects source, each forbidden cell and blank destination", async t => {
  const dir = fixtureDirectory(t);
  const file = path.join(dir, "strict.xlsx");
  const rows = [
    ["OK", "Товар", 6, null, 0, null, 0, 4],
    ["RECEIPT", "Товар", 3, 1, 0, null, 0, 4],
    ["RECEIPT-ZERO", "Товар", 3, 0, 0, null, 0, 3],
    ["RETAIL", "Товар", 3, null, 0, 1, 0, 2],
    ["RETAIL-ZERO", "Товар", 3, null, 0, 0, 0, 3],
    ["BOTH", "Товар", 3, 1, 0, 1, 0, 3],
    ["NO-START", "Товар", null, null, 0, null, 0, 3],
    ["NO-STOCK", "Товар", 3, null, 0, null, 0, null]
  ];
  await writeReport(file, [
    ["Toppers 02 Lviv Staroevreyska", rows],
    ["Т1", rows.map(row => [row[0], "Товар", 8, null, 0, null, 0, 8])],
    ["Т3", rows.map(row => [row[0], "Товар", 1, 2, 3, 3, 0, null])],
    ["Т4", rows.map(row => [row[0], "Товар", 1, null, 0, null, 0, 0])]
  ]);
  assert.equal(shouldTransferOpeningStock(STRICT_QUERY), true);
  const before = fs.readFileSync(file);
  const result = await buildOpeningStockTransfer({ query: STRICT_QUERY, files: [file], outDir: dir });
  assert.deepEqual(result.lines.map(({ from, to, sku, qty }) => ({ from, to, sku, qty })),
    [{ from: "Т2", to: "Т3", sku: "OK", qty: 4 }]);
  assert.equal(result.strictBlanks, true);
  assert.deepEqual(fs.readFileSync(file), before);

  // Оба интерфейса проходят через Agent: без LLM и без развозки по продажам.
  t.mock.method(globalThis, "fetch", () => { throw new Error("Сеть не нужна"); });
  for (const prefix of ["/excel ", ""]) {
    const answer = await new Agent(`strict-${prefix.length}-${process.pid}`).process(`${prefix}${STRICT_QUERY} "${file}"`);
    const output = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m)?.[1];
    assert.ok(output, answer);
    t.after(() => {
      assert.ok(path.resolve(output).startsWith(path.resolve("exports") + path.sep));
      fs.rmSync(output, { force: true });
    });
    assert.match(answer, /Магазин-источник: Т2/);
    const book = await new ExcelJS.Workbook().xlsx.readFile(output);
    assert.deepEqual(book.getWorksheet("Перемещение").getRow(2).values.slice(1, 6),
      ["Т2", "Т3", "OK", "Товар", 4]);
    assert.equal(book.getWorksheet("Перемещение").rowCount, 2);
  }

  const missing = path.join(dir, "missing-receipt.xlsx");
  await writeReport(missing, [
    ["Т2", [["OK", "Товар", 4, 0, null, 0, 4]]],
    ["Т3", [["OK", "Товар", 0, 0, null, 0, null]]]
  ], HEADER.filter(header => header !== "Приход"));
  const rejected = await buildOpeningStockTransfer({ query: STRICT_QUERY, files: [missing], outDir: dir });
  assert.equal(rejected.status, "empty");
  assert.match(rejected.notes.join(" "), /Приход/);

  const similar = path.join(dir, "similar-headers.xlsx");
  await writeReport(similar, [
    ["Т2", [["OK", "Товар", 4, null, 0, null, 0, 4, 2]]],
    ["Т3", [["OK", "Товар", 0, null, 0, null, 0, null, 0]]]
  ], [...HEADER, "Оприходование запасов"]);
  const matched = await buildOpeningStockTransfer({ query: STRICT_QUERY, files: [similar], outDir: dir });
  assert.equal(matched.lines.length, 1);
  assert.equal(matched.lines[0].qty, 4);
});

function fixtureDirectory(t) {
  const root = path.resolve("test");
  const dir = fs.mkdtempSync(path.join(root, ".tmp-opening-transfer-"));
  t.after(() => {
    assert.ok(fs.realpathSync(dir).startsWith(root + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeReport(file, sections, header = HEADER) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("TDSheet");
  sheet.addRow(header);
  sheet.addRow(["Номенклатура.Артикул", "Номенклатура.Найменування"]);
  for (const [point, rows] of sections) {
    sheet.addRow([point, "", ...header.slice(2).map(() => 0)]);
    rows.forEach(row => sheet.addRow(row));
  }
  await book.xlsx.writeFile(file);
}

test("opening transfers use only opening unsold stock and explicitly blank destinations", async t => {
  const dir = fixtureDirectory(t);
  const file = path.join(dir, "год все магазины.xlsx");
  const eligible = ["A", "B", "C", "D", "NO-START", "RETAIL", "GONE", "BAD-RETAIL"];
  await writeReport(file, [
    ["Toppers 01 Lviv Gnatuka", [
      ["A", "Ограничено началом", 5, 10, 0, null, 0, 15],
      ["B", "Часть ушла оптом", 8, 0, 5, 0, 5, 3],
      ["C", "Не продавался нигде", 1, 0, 0, "0,00", 0, 1],
      ["D", "Дробный остаток", "2,9", 0, 0, 0, 0, "2,9"],
      ["NO-START", "Только приход", null, 6, 0, null, 0, 6],
      ["RETAIL", "Есть розничные продажи", 6, 0, 1, 1, 0, 5],
      ["GONE", "Выбыл целиком", 4, 0, 4, null, 4, null],
      ["BAD-RETAIL", "Некорректные продажи", 2, 0, 0, "ошибка 0", 0, 2],
      ["ABSENT", "Нет строки у получателей", 3, 0, 0, null, 0, 3]
    ]],
    ["Т2", eligible.map(sku => [sku, `Товар ${sku}`, null, 0, 0, null, 0, null])],
    ["Т3", eligible.map(sku => [sku, `Товар ${sku}`, 3, 0, 3, 3, 0, " "])],
    ["Т4", eligible.map(sku => [sku, `Товар ${sku}`, 3, 0, 3, 3, 0, 0])],
    ["Т5", eligible.map(sku => [sku, `Товар ${sku}`, 3, 0, 2, 2, 0, 1])],
    ["Т6", eligible.map(sku => [sku, `Товар ${sku}`, 3, 0, 4, 4, 0, -1])]
  ]);
  const before = fs.readFileSync(file);
  const result = await buildOpeningStockTransfer({ files: [file], outDir: dir });
  assert.equal(result.status, "success");
  assert.equal(result.stats.units, 11);
  assert.deepEqual([...new Set(result.lines.map(line => line.sku))].sort(), ["A", "B", "C", "D"]);
  for (const [sku, expected] of [["A", 5], ["B", 3], ["C", 1], ["D", 2]]) {
    const lines = result.lines.filter(line => line.sku === sku);
    assert.equal(lines.reduce((sum, line) => sum + line.qty, 0), expected);
    const quantities = ["Т2", "Т3"].map(point =>
      lines.filter(line => line.to === point).reduce((sum, line) => sum + line.qty, 0));
    assert.ok(Math.abs(quantities[0] - quantities[1]) <= 1);
  }
  for (const line of result.lines) {
    assert.equal(line.from, "Т1");
    assert.ok(["Т2", "Т3"].includes(line.to));
    assert.ok(Number.isInteger(line.qty) && line.qty > 0);
    assert.ok(line.qty <= Math.min(line.sourceStart, line.sourceEnd));
    assert.equal(line.sourceRetail, 0);
    assert.ok(line.destEnd === "" || line.destEnd === null);
  }
  assert.deepEqual(fs.readFileSync(file), before, "исходная книга не меняется");
  const saved = await new ExcelJS.Workbook().xlsx.readFile(result.outputPath);
  const output = saved.getWorksheet("Перемещение");
  assert.ok(output);
  assert.equal(output.rowCount, result.lines.length + 1);
  const header = output.getRow(1).values;
  const quantityColumn = header.indexOf("Кол-во");
  assert.ok(quantityColumn > 0);
  let total = 0;
  output.eachRow((row, index) => { if (index > 1) total += row.getCell(quantityColumn).value; });
  assert.equal(total, 11);
});

test("opening transfers balance remainders across multiple sources and keep SKU identities", async t => {
  const dir = fixtureDirectory(t);
  const file = path.join(dir, "balances.xlsx");
  await writeReport(file, [
    ["Т1", [[" a ", "А", 1, 0, 0, null, 0, 1], ["0108", "Другой артикул", 2, 0, 0, 0, 0, 2]]],
    ["Т2", [["A", "А", 1, 0, 0, null, 0, 1]]],
    ["Т3", [["A", "А", 1, 0, 0, null, 0, 1]]],
    ["Т4", [["A", "А", 0, 0, 0, 0, 0, null], ["108", "Не 0108", 0, 0, 0, 0, 0, null]]],
    ["Т5", [["A", "А", 0, 0, 0, 0, 0, null]]]
  ]);
  const result = await buildOpeningStockTransfer({ files: [file], outDir: dir });
  assert.equal(result.stats.units, 3);
  const totals = ["Т4", "Т5"].map(point =>
    result.lines.filter(line => line.to === point).reduce((sum, line) => sum + line.qty, 0));
  assert.deepEqual(totals.sort(), [1, 2]);
  assert.deepEqual([...new Set(result.lines.map(line => line.from))].sort(), ["Т1", "Т2", "Т3"]);
  assert.ok(result.lines.every(line => line.sku.trim().toUpperCase() === "A"));
});

test("opening transfers reject missing columns and invalid quantities instead of assuming zero", async t => {
  const dir = fixtureDirectory(t);
  for (const omitted of ["Начало", "Отчет о розничных продажах", "Конец"]) {
    const file = path.join(dir, `${omitted}.xlsx`);
    const index = HEADER.indexOf(omitted);
    const without = row => row.filter((_value, i) => i !== index);
    await writeReport(file, [
      ["Т1", [without(["A", "Товар", 3, 0, 0, 0, 0, 3])]],
      ["Т2", [without(["A", "Товар", 0, 0, 0, 0, 0, null])]]
    ], without(HEADER));
    const result = await buildOpeningStockTransfer({ files: [file], outDir: dir });
    assert.equal(result.status, "empty", omitted);
    assert.equal(result.outputPath, null);
    assert.equal(result.lines.length, 0);
    assert.ok(result.notes.length > 0, "причина пропуска должна быть видна");
  }
  const file = path.join(dir, "invalid.xlsx");
  await writeReport(file, [
    ["Т1", [["A", "Товар", 3, 0, 0, "нет 0", 0, 3], ["B", "Товар", "#VALUE!", 0, 0, 0, 0, 3]]],
    ["Т2", [["A", "Товар", 0, 0, 0, 0, 0, null], ["B", "Товар", 0, 0, 0, 0, 0, null]]]
  ]);
  const result = await buildOpeningStockTransfer({ files: [file], outDir: dir });
  assert.equal(result.lines.length, 0);
  assert.ok(result.notes.length > 0);
});

test("opening transfers resolve Ukrainian and reordered columns across shop worksheets", async t => {
  const dir = fixtureDirectory(t);
  const file = path.join(dir, "shops.xlsx");
  const book = new ExcelJS.Workbook();
  const source = book.addWorksheet("Т1");
  source.addRow(["Артикул", "Название", "Кінець", "Звіт про роздрібні продажі", "Початок"]);
  source.addRow(["A", "Товар", 5, null, 2]);
  const destination = book.addWorksheet("Т2");
  destination.addRow(["Артикул", "Название", "Початок", "Звіт про роздрібні продажі", "Кінець"]);
  destination.addRow(["A", "Товар", 1, 1, null]);
  await book.xlsx.writeFile(file);
  const result = await buildOpeningStockTransfer({ files: [file], outDir: dir });
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].from, "Т1");
  assert.equal(result.lines[0].to, "Т2");
  assert.equal(result.lines[0].qty, 2);
});

test("an empty shop subtotal starts its own block instead of borrowing the previous shop", async t => {
  const dir = fixtureDirectory(t);
  const file = path.join(dir, "empty-shop.xlsx");
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("TDSheet");
  sheet.addRow(HEADER);
  sheet.addRow(["Номенклатура.Артикул", "Номенклатура.Найменування"]);
  sheet.addRow(["Т1", "", 3, 0, 0, 0, 0, 3]);
  sheet.addRow(["A", "Товар", 3, 0, 0, 0, 0, 3]);
  sheet.addRow(["Toppers Інстаграм"]);
  sheet.addRow(["A", "Товар"]);
  await book.xlsx.writeFile(file);
  assert.equal(looksLikeSectionRow(["Toppers Інстаграм"]), true);
  assert.equal(looksLikeSectionRow(["Т2"]), true);
  assert.equal(looksLikeSectionRow(["SO8611"]), false);
  assert.equal(looksLikeSectionRow(["Разом"]), false);
  const result = await buildOpeningStockTransfer({ files: [file], outDir: dir });
  assert.equal(result.stats.points, 2);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].from, "Т1");
  assert.equal(result.lines[0].to, "Т-ІНСТАГРАМ");
  assert.equal(result.lines[0].qty, 3);
});

test("opening transfers deduplicate snapshots and reject conflicting pairs", async t => {
  const dir = fixtureDirectory(t);
  const oldFile = path.join(dir, "old.xlsx");
  const newFile = path.join(dir, "new.xlsx");
  await writeReport(oldFile, [["Toppers 01 Lviv", [["A", "Товар", 50, 0, 0, 0, 0, 50]]]]);
  await writeReport(newFile, [
    ["Т1", [
      ["A", "Товар", 3, 0, 0, 0, 0, 3],
      ["A", "Товар", 3, 0, 0, 0, 0, 3],
      ["B", "Конфликт", 4, 0, 0, 0, 0, 4],
      ["B", "Конфликт", 4, 0, 1, 1, 0, 3],
      ["C", "Конфликт получателя", 4, 0, 0, 0, 0, 4]
    ]],
    ["Т2", [
      ["A", "Товар", 0, 0, 0, 0, 0, null],
      ["B", "Конфликт", 0, 0, 0, 0, 0, null],
      ["C", "Конфликт получателя", 0, 0, 0, 0, 0, null],
      ["C", "Конфликт получателя", 0, 0, 0, 0, 0, 1]
    ]]
  ]);
  fs.utimesSync(oldFile, new Date("2026-01-01"), new Date("2026-01-01"));
  fs.utimesSync(newFile, new Date("2026-02-01"), new Date("2026-02-01"));
  const result = await buildOpeningStockTransfer({ files: [oldFile, newFile], outDir: dir });
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].sku, "A");
  assert.equal(result.lines[0].qty, 3);
  assert.ok(result.notes.length > 0);
});

test("opening-stock command routes through the shared CLI and Telegram agent without AI", async t => {
  const dir = fixtureDirectory(t);
  const file = path.join(dir, "report.xlsx");
  await writeReport(file, [
    ["Т1", [["A", "Товар", 2, 0, 0, null, 0, 2]]],
    ["Т2", [["A", "Товар", 0, 0, 0, null, 0, null]]]
  ]);
  t.mock.method(globalThis, "fetch", () => { throw new Error("Этому сценарию сеть не нужна"); });
  const phrases = [
    "переноси из начала без розничных продаж туда, где конец пустой",
    "перенеси товары из столбца начало без отчета о розничных продажах на магазины где товара нет",
    "перемести товары со столбца начало которые не имеют отчета о розничных продажах",
    "перенос из начала",
    "перемещение из начала"
  ];
  for (const phrase of phrases) {
    assert.equal(shouldTransferOpeningStock(phrase), true, phrase);
    assert.equal(shouldUseExcelTool(phrase), true, phrase);
  }
  for (const phrase of ["развези по продажам", "перемещение", "перенеси где реализация<20%", "непроданное", "заказ по отчету о розничных продажах"]) {
    assert.equal(shouldTransferOpeningStock(phrase), false, phrase);
  }
  const outputs = new Set();
  t.after(() => {
    for (const output of outputs) {
      assert.ok(path.resolve(output).startsWith(path.resolve("exports") + path.sep));
      fs.rmSync(output, { force: true });
    }
  });
  const run = async (phrase, chatId) => {
    const answer = await new Agent(chatId).process(`${phrase} "${file}"`);
    const match = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);
    if (match) outputs.add(match[1]);
    assert.ok(match, answer);
    assert.match(path.basename(match[1]), /^peremeshchenie-iz-nachala-/);
    return answer;
  };
  await run(`/excel ${phrases[1]}`, `test-opening-cli-${process.pid}`);
  await run(phrases[3], `test-opening-telegram-${process.pid}`);
  const answer = await runExcelTool({ query: phrases[2], memories: [`Excel файл загружен: ${file}`] });
  const match = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);
  if (match) outputs.add(match[1]);
  assert.ok(match, answer);
  assert.match(path.basename(match[1]), /^peremeshchenie-iz-nachala-/);
});
