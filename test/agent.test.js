import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import Agent, { shouldUseExcelTool, shouldUseProjectManager } from "../src/agent.js";
import * as memory from "../src/memory.js";
import * as projects from "../src/projects.js";
import {
  CRITERIA_PRESETS,
  EXCEL_ACTIONS,
  resolveWebAppUrl,
  sanitizeFileName
} from "../src/telegram.js";
import {
  existsInProject,
  extractNamedSpreadsheetPaths,
  extractSpreadsheetPaths,
  loadWorkbooks
} from "../src/tools/excel/reader.js";
import { extractKeepPhrase } from "../src/tools/excel/filterByName.js";
import {
  discoverChatFiles,
  resolveFiles
} from "../src/tools/excel/shared.js";
import { allocateProportionally } from "../src/tools/excel/redistribute.js";
import {
  parseCriteria,
  parseSourcePoint
} from "../src/tools/excel/transferByCriteria.js";
import {
  comparePointCodes,
  normalizePointCode,
  parseDestinationPoint,
  parseDestinationPoints,
  parseExcludedPoints,
  parseSourcePoints,
  rememberPointName,
  resetPointRegistry
} from "../src/tools/excel/points.js";
import { keepFreshestPointRecords } from "../src/tools/excel/shared.js";
import { planTransfers } from "../src/tools/excel/transferByCriteria.js";
import { parseNumber } from "../src/tools/excel/search.js";
import excelTool from "../src/tools/excel/excelTool.js";
import { parseTransferText } from "../src/tools/excel/transferBuilder.js";
import { parseSheetOperations } from "../src/tools/excel/sheets.js";

delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;

test("excel path extraction keeps Telegram paths with spaces", () => {
  const filePath =
    "data/telegram/7443435334/1783327207119-1783326834514-T1 18.06-5.07.2026ic.xlsx.xlsx";
  const memoryText = [
    "Excel файл загружен:",
    filePath,
    "Я сохранил путь в память."
  ].join("\n");

  assert.deepEqual(
    extractSpreadsheetPaths(memoryText),
    [filePath]
  );
  assert.deepEqual(
    extractNamedSpreadsheetPaths(`остатки=${filePath}`, ["остатки"]),
    [filePath]
  );
});

test("comma in a Telegram file name does not spawn a bogus path", () => {
  const original = "Т1_продажі_16_08_2_09_2026_проставлені_формули,_фільтр_більше_40%.xlsx";
  const stored = `data/telegram/8648503864/1788439603766-${sanitizeFileName(original)}`;
  const memoryText = `Excel файл загружен: ${stored}`;

  assert.ok(!stored.includes(","), "запятая должна быть вычищена из имени");
  assert.deepEqual(extractSpreadsheetPaths(memoryText), [stored]);
});

test("existsInProject rejects missing and out-of-project paths", () => {
  assert.equal(existsInProject("_фільтр_більше_40%.xlsx"), false);
  assert.equal(existsInProject("../../etc/passwd.xlsx"), false);
  assert.equal(existsInProject("package.json"), true);
});

test("loadWorkbooks skips stale paths, never echoes the bad name", async () => {
  const dir = path.join(process.cwd(), "test", ".tmp-stale");
  const good = path.join(dir, "real.xlsx");

  fs.rmSync(dir, { recursive: true, force: true });
  await writeTestWorkbook(good, "Лист", [{ "Артикул": "A1", "Остаток": 5 }]);

  const goodPath = path.relative(process.cwd(), good).split(path.sep).join("/");
  const bad = "_фільтр_більше_40%.xlsx";

  // Только битый путь из памяти -> обобщённая ошибка, без самого пути.
  assert.throws(
    () => loadWorkbooks([bad]),
    error => !/_фільтр/.test(error.message) && /Отправь отчёт боту заново/.test(error.message)
  );

  // Битый рядом с реальным -> реальный грузится, битый молча пропущен.
  assert.equal(loadWorkbooks([goodPath, bad]).length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("agent remembers and recalls text", async () => {
  await memory.clear();
  const agent = new Agent();

  assert.equal(
    await agent.process("память"),
    "Пока ничего не помню. Мозг чистый, как новая база данных."
  );
  assert.equal(
    await agent.process("запомни я учу JavaScript"),
    "Запомнил: я учу JavaScript"
  );
  assert.equal(await agent.process("что ты помнишь"), "я учу JavaScript");
});

test("agent calculates simple expressions", async () => {
  const agent = new Agent();

  assert.equal(await agent.process("calc 2 + 2 * 3"), "8");
});

test("agent rejects unsafe calculations", async () => {
  const agent = new Agent();

  assert.equal(
    await agent.process("calc process.exit()"),
    "Можно считать только простые математические выражения."
  );
});

test("agent exposes codebase analyzer tool", async () => {
  const agent = new Agent();

  assert.match(
    await agent.process("/tools"),
    /\/codebase/
  );
});

test("agent exposes image drawing tool", async () => {
  const agent = new Agent();

  assert.match(
    await agent.process("/tools"),
    /\/draw/
  );
});

test("agent creates image generation files", async t => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: {
      images: [{ image_url: { url: "data:image/png;base64,dGVzdA==" } }]
    } }] })
  }));
  const agent = new Agent();
  t.after(() => {
    if (agent.lastImagePath) fs.unlinkSync(agent.lastImagePath);
  });
  const answer = await agent.process("/draw neon cat");

  assert.match(answer, /Картинка-файл:/);
  assert.match(answer, /exports[\\/]image-.+\.\w+/);
});

test("agent switches back to default mode", async () => {
  const agent = new Agent();

  assert.equal(
    await agent.process("/agent default"),
    "Режим агента переключён: default"
  );
});

async function writeTestWorkbook(filePath, sheetName, rows) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sheetName);
  const headers = Object.keys(rows[0]);

  worksheet.addRow(headers);

  for (const row of rows) {
    worksheet.addRow(headers.map(header => row[header]));
  }

  fs.mkdirSync(path.dirname(filePath), {
    recursive: true
  });

  await workbook.xlsx.writeFile(filePath);
}

// Реалистичный «сырой» отчёт движения (как выгрузка из BAS): только базовые
// колонки, без заранее проставленных формул оборачиваемости. Колонка «Конец»
// стоит на позиции 10 — проверяем определение колонок по заголовкам.
async function writeT1ReportWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("TDSheet");

  worksheet.addRows([
    [
      "Місце зберігання",
      "",
      "Начало",
      "Приход",
      "Оприходование запасов",
      "Поступление от поставщика",
      "Расход",
      "Отчет о розничных продажах",
      "Продажа покупателю",
      "Списание запасов",
      "Конец"
    ],
    [
      "Номенклатура.Артикул",
      "Номенклатура.Найменування",
      "Кількість",
      "Кількість",
      "Кількість",
      "Кількість",
      "Кількість",
      "Кількість",
      "Кількість",
      "Кількість",
      "Кількість"
    ],
    // Строка-заголовок склада: во второй колонке пусто — не товар.
    ["ТТ-01 Львів", "", 100, 10, 0, 10, 50, 45, 5, 0, 60],
    // Подходит: презервативы, есть расход, запас в норме.
    ["SO-1001", "Презервативи LELO HEX Original 3 Pack", 8, 0, 0, 0, 6, 6, 0, 0, 2],
    // Отсеивается: реализация 2/40 = 5% < 40%.
    ["SO-1002", "Змазка System JO H2O ORIGINAL 120 мл", 40, 0, 0, 0, 2, 2, 0, 0, 38],
    // Подходит: лубрикант.
    ["SX-2001", "Лубрикант Swiss Navy NAKED 59 мл", 5, 5, 0, 5, 4, 3, 1, 0, 6],
    // Отсеивается: нет продаж за период (расход = 0).
    ["AD-3001", "Презервативи Durex Classic 12 шт", 3, 0, 0, 0, 0, 0, 0, 0, 3],
    // Отсеивается: не наша категория — это возят, а не заказывают.
    ["ZZ-9001", "Вібратор We-Vibe Moxie Blue", 5, 0, 0, 0, 5, 5, 0, 0, 0],
    // Подходит: лубрикант.
    ["PJ-4001", "Змазка pjur Original 30 мл", 4, 0, 0, 0, 3, 3, 0, 0, 1]
  ]);

  fs.mkdirSync(path.dirname(filePath), {
    recursive: true
  });

  await workbook.xlsx.writeFile(filePath);
}

test("agent prepares supplier purchase order from Excel files", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-excel");
  const stockFile = path.join(tempDir, "ostatki.xlsx");
  const priceFile = path.join(tempDir, "price.xlsx");
  // Свой chatId — иначе new Agent() садится в "default" и подбирает
  // реальные файлы из production-памяти (DATABASE_URL смотрит на боевую
  // базу), а не только явно переданные остатки/прайс.
  const chatId = "test-purchase-order-explicit-files";

  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });
  await memory.clear(chatId);

  await writeTestWorkbook(stockFile, "Остатки", [
    {
      "Артикул": "SKU-1",
      "Товар": "Крем для рук",
      "Остаток": 1,
      "Минимальный остаток": 3,
      "Целевой остаток": 8
    },
    {
      "Артикул": "SKU-2",
      "Товар": "Шампунь",
      "Остаток": 20,
      "Минимальный остаток": 3,
      "Целевой остаток": 8
    }
  ]);

  await writeTestWorkbook(priceFile, "Прайс", [
    {
      "Артикул": "SKU-1",
      "Товар": "Крем для рук",
      "Поставщик": "Best Supplier",
      "Цена": 10
    },
    {
      "Артикул": "SKU-1",
      "Товар": "Крем для рук",
      "Поставщик": "Expensive Supplier",
      "Цена": 15
    }
  ]);

  const agent = new Agent(chatId);
  const answer = await agent.process(
    `/excel заказ остатки=${stockFile} прайс=${priceFile}`
  );
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.match(answer, /Заказ поставщику подготовлен/);
  assert.match(answer, /Позиции к заказу: 1/);
  assert.match(answer, /Предварительная сумма: 70\.00/);
  assert.ok(fileMatch);
  assert.ok(fs.existsSync(fileMatch[1]));

  fs.rmSync(fileMatch[1], {
    force: true
  });

  const outputDir = path.dirname(fileMatch[1]);

  if (path.basename(outputDir) === "exports" && fs.readdirSync(outputDir).length === 0) {
    fs.rmdirSync(outputDir);
  }

  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });
  await memory.clear(chatId);
});

test("agent prepares purchase order from remembered Telegram path with spaces", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-excel-spaces");
  const stockFile = path.join(tempDir, "T1 18.06-5.07.2026ic.xlsx");
  const chatId = "test-telegram-path-with-spaces";

  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });
  await memory.clear(chatId);

  await writeTestWorkbook(stockFile, "Остатки", [
    {
      "Артикул": "SKU-SPACE",
      "Товар": "Товар из Telegram",
      "Остаток": 1,
      "Минимальный остаток": 3,
      "Целевой остаток": 6
    }
  ]);

  const projectPath = path
    .relative(process.cwd(), stockFile)
    .split(path.sep)
    .join("/");

  await memory.save(
    `Excel файл загружен: ${projectPath}`,
    chatId
  );

  const agent = new Agent(chatId);
  const answer = await agent.process("Подготовь заказ поставщику.");
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.match(answer, /Заказ поставщику подготовлен/);
  assert.match(answer, /Позиции к заказу: 1/);
  assert.ok(fileMatch);
  assert.ok(fs.existsSync(fileMatch[1]));

  fs.rmSync(fileMatch[1], {
    force: true
  });

  const outputDir = path.dirname(fileMatch[1]);

  if (path.basename(outputDir) === "exports" && fs.readdirSync(outputDir).length === 0) {
    fs.rmdirSync(outputDir);
  }

  await memory.clear(chatId);
  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });
});

test("agent prepares T1 sales order from remembered Telegram report", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-t1-memory");
  const reportFile = path.join(tempDir, "T1 18.06-5.07.2026ic.xlsx");
  const chatId = "test-t1-telegram-report";

  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });
  await memory.clear(chatId);

  await writeT1ReportWorkbook(reportFile);

  const projectPath = path
    .relative(process.cwd(), reportFile)
    .split(path.sep)
    .join("/");

  await memory.save(
    `Excel файл загружен: ${projectPath}`,
    chatId
  );

  const agent = new Agent(chatId);
  const answer = await agent.process("Подготовь заказ поставщику.");
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.match(answer, /Замовлення Т1 подготовлено/);
  assert.match(answer, /Лист «Замовлення» \(весь товар\): 4 позиций/);
  // Период вычислен из дат в имени файла (18.06-5.07 -> 18 дней).
  assert.match(answer, /Период отчёта: 18 дн\./);
  assert.ok(fileMatch);
  assert.ok(fs.existsSync(fileMatch[1]));

  fs.rmSync(fileMatch[1], {
    force: true
  });

  const outputDir = path.dirname(fileMatch[1]);

  if (path.basename(outputDir) === "exports" && fs.readdirSync(outputDir).length === 0) {
    fs.rmdirSync(outputDir);
  }

  await memory.clear(chatId);
  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });
});

test("agent prepares T1 sales order from movement report", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-t1-order");
  const reportFile = path.join(tempDir, "t1-report.xlsx");

  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });

  await writeT1ReportWorkbook(reportFile);

  const agent = new Agent();
  const answer = await agent.process(
    `/excel замовлення ${reportFile}`
  );
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.match(answer, /Замовлення Т1 подготовлено/);
  // По умолчанию заказ по всему товару: SO-1001, PJ-4001, SX-2001 и вибратор
  // ZZ-9001. SO-1002 отсеян по реализации <40%, AD-3001 без продаж.
  assert.match(answer, /Лист «Замовлення» \(весь товар\): 4 позиций, 27 ед\. к заказу/);
  assert.match(answer, /Заказ по всему товару/);
  assert.doesNotMatch(answer, /не та категория/);
  assert.match(answer, /<40% реализации — 1/);
  // В выгрузке одна точка — перемещать физически некуда.
  assert.match(answer, /Лист «Переміщення»: 0 строк/);
  assert.ok(fileMatch);
  assert.ok(fs.existsSync(fileMatch[1]));

  const workbook = await new ExcelJS.Workbook().xlsx.readFile(fileMatch[1]);
  const worksheet = workbook.getWorksheet("Замовлення");

  // Обычный заказ идёт по рангу префикса из config.yaml: PJ -> SX -> SO,
  // чужой префикс (ZZ) последним.
  assert.equal(worksheet.getCell("A2").value, "PJ-4001");
  assert.equal(worksheet.getCell("A3").value, "SX-2001");
  assert.equal(worksheet.getCell("A4").value, "SO-1001");
  assert.equal(worksheet.getCell("A5").value, "ZZ-9001");
  // Категория проставлена всегда, даже когда она ничего не фильтрует.
  assert.equal(worksheet.getCell("N2").value, "Лубриканти");
  assert.equal(worksheet.getCell("N4").value, "Презервативи");
  assert.equal(worksheet.getCell("N5").value, "");
  assert.match(worksheet.getCell("M2").value.formula, /ROUNDUP/);
  // baseline computeRecommendedOrder = ceil(Расход*2 - Конец):
  // PJ ceil(3*2-1)=5, SX ceil(4*2-6)=2, SO ceil(6*2-2)=10, ZZ ceil(5*2-0)=10.
  assert.equal(worksheet.getCell("M2").value.result, 5);
  assert.equal(worksheet.getCell("M3").value.result, 2);
  assert.equal(worksheet.getCell("M4").value.result, 10);
  assert.equal(worksheet.getCell("M5").value.result, 10);
  // Второй лист есть всегда: пустой — с объяснением, почему.
  assert.ok(workbook.getWorksheet("Переміщення"));

  fs.rmSync(fileMatch[1], {
    force: true
  });

  const outputDir = path.dirname(fileMatch[1]);

  if (path.basename(outputDir) === "exports" && fs.readdirSync(outputDir).length === 0) {
    fs.rmdirSync(outputDir);
  }

  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });
});

test("order takes only condoms and lubricants, the rest is moved between stores", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-order-split");
  const header = ["Місце зберігання", "", "Начало", "Приход", "Расход",
    "Отчет о розничных продажах", "Продажа покупателю", "Конец"];

  fs.rmSync(tempDir, { recursive: true, force: true });

  const t1 = path.join(tempDir, "t1.xlsx");
  const t2 = path.join(tempDir, "t2.xlsx");

  // Т1: лубрикант продаётся (80%) — его заказываем. Вибратор стоит (8%) —
  // это не наша категория, его не докупают, а увозят.
  await writeSalesReportWorkbook(t1, "Т1", header, [
    ["SX-100", "Лубрикант Swiss Navy NAKED 59 мл", 10, 0, 8, 8, 0, 2],
    ["VB-200", "Вібратор We-Vibe Moxie Blue", 12, 0, 1, 1, 0, 11]
  ]);
  // Т2: тот же вибратор продаётся и кончился — вот кому его везти.
  await writeSalesReportWorkbook(t2, "Т2", header, [
    ["VB-200", "Вібратор We-Vibe Moxie Blue", 4, 0, 4, 4, 0, 0]
  ]);

  const agent = new Agent();
  const answer = await agent.process(
    `/excel замовлення только презервативы и лубриканты ${t1} ${t2}`
  );
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.match(answer, /Замовлення Т1 подготовлено/);
  // Заказ: только лубрикант, ceil(8*2-2) = 14 ед.
  assert.match(answer, /Лист «Замовлення» \(Презервативи \+ Лубриканти\): 1 позиций, 14 ед\. к заказу/);
  assert.match(answer, /Заказ сужен до категорий/);
  // Перемещение: Т2 продаёт 4 шт/период, остатка нет -> на 36 дней покрытия
  // ему нужно 8 шт., у Т1 лежит 11.
  assert.match(answer, /Лист «Переміщення»: 1 строк, 8 ед\. по 2 точкам/);
  assert.ok(fileMatch);

  const workbook = await new ExcelJS.Workbook().xlsx.readFile(fileMatch[1]);
  const order = workbook.getWorksheet("Замовлення");
  const transfer = workbook.getWorksheet("Переміщення");

  assert.equal(order.getCell("A2").value, "SX-100");
  assert.equal(order.getCell("N2").value, "Лубриканти");
  // Вибратора в заказе быть не должно ни одной строкой.
  assert.equal(order.rowCount, 2);
  assert.deepEqual(
    transfer.getRow(2).values.slice(1, 6),
    ["Т1", "Т2", "VB-200", "Вібратор We-Vibe Moxie Blue", 8]
  );

  fs.rmSync(fileMatch[1], { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("asking for condoms and lubricants narrows the same order", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-t1-categories");
  const reportFile = path.join(tempDir, "t1-report.xlsx");

  fs.rmSync(tempDir, { recursive: true, force: true });

  await writeT1ReportWorkbook(reportFile);

  const agent = new Agent();
  const answer = await agent.process(
    `/excel замовлення тільки презервативи та лубриканти ${reportFile}`
  );
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  // Тот же отчёт, что и в заказе по всему товару (4 позиции, 27 ед.), но
  // вибратор ZZ-9001 отсеян как не та категория.
  assert.match(answer, /Лист «Замовлення» \(Презервативи \+ Лубриканти\): 3 позиций, 17 ед\. к заказу/);
  assert.match(answer, /не та категория — 1/);
  assert.ok(fileMatch);

  const workbook = await new ExcelJS.Workbook().xlsx.readFile(fileMatch[1]);
  const worksheet = workbook.getWorksheet("Замовлення");

  // В суженном заказе строки идут категориями: сначала презервативы.
  assert.equal(worksheet.getCell("A2").value, "SO-1001");
  assert.equal(worksheet.getCell("N2").value, "Презервативи");
  assert.equal(worksheet.getCell("A3").value, "PJ-4001");

  fs.rmSync(fileMatch[1], { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("combineSheetLines merges the same SKU across points into one order line", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-combine-points");
  const reportFile = path.join(tempDir, "vsi-magazini.xlsx");
  const header = ["Місце зберігання", "", "Начало", "Приход", "Расход",
    "Отчет о розничных продажах", "Продажа покупателю", "Конец"];
  const units = ["Номенклатура.Артикул", "Номенклатура.Найменування"];

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const workbook = new ExcelJS.Workbook();

  // Один и тот же SX-100 продаётся на двух точках одной книги — реальный
  // случай выгрузки «Всі магазини», из-за которого combineSheetLines и завели.
  const sheetT1 = workbook.addWorksheet("Т1");

  sheetT1.addRows([
    header,
    units,
    ["Т1", "", 10, 0, 8, 8, 0, 2],
    ["SX-100", "Лубрикант Swiss Navy NAKED 59 мл", 10, 0, 8, 8, 0, 2]
  ]);

  const sheetT2 = workbook.addWorksheet("Т2");

  sheetT2.addRows([
    header,
    units,
    ["Т2", "", 5, 0, 4, 4, 0, 1],
    ["SX-100", "Лубрикант Swiss Navy NAKED 59 мл", 5, 0, 4, 4, 0, 1]
  ]);

  await workbook.xlsx.writeFile(reportFile);

  const agent = new Agent();
  const answer = await agent.process(`/excel замовлення ${reportFile}`);
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  // Раздельно: Т1 ceil(8*2-2)=14, Т2 ceil(4*2-1)=7 — итого 2 строки, 21 ед.
  // Объединено: available=15, expense=12, end=3 -> ceil(12*2-3)=21, но уже
  // ОДНОЙ строкой — это и отличает объединение от простого сложения текста.
  assert.match(answer, /Лист «Замовлення» \(весь товар\): 1 позиций, 21 ед\. к заказу/);
  assert.ok(fileMatch);
  assert.ok(fs.existsSync(fileMatch[1]));

  const resultWorkbook = await new ExcelJS.Workbook().xlsx.readFile(fileMatch[1]);
  const worksheet = resultWorkbook.getWorksheet("Замовлення");

  assert.equal(worksheet.getCell("A2").value, "SX-100");
  assert.equal(worksheet.rowCount, 2);

  fs.rmSync(fileMatch[1], { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("project manager tracks name, stack, status and tasks through a chat", async () => {
  const chatId = "test-project-manager";

  await projects.clearProjects(chatId);

  const agent = new Agent(chatId);

  assert.match(
    await agent.process("создай проект Telegram Shop Bot"),
    /Проект «Telegram Shop Bot» создан\. Статус: новый\./
  );
  // Повторное создание не должно стирать уже собранные данные.
  assert.match(
    await agent.process("создай проект Telegram Shop Bot"),
    /уже есть/
  );
  assert.match(
    await agent.process("проект Telegram Shop Bot стек: Node.js, Telegraf"),
    /Стек проекта «Telegram Shop Bot» обновлён: Node\.js, Telegraf/
  );
  assert.match(
    await agent.process("проект Telegram Shop Bot статус: в разработке"),
    /Статус проекта «Telegram Shop Bot»: в разработке/
  );
  assert.match(
    await agent.process("проект Telegram Shop Bot задача: настроить оплату"),
    /Задача добавлена/
  );
  assert.match(
    await agent.process("проект Telegram Shop Bot задача: подключить БД"),
    /Задача добавлена/
  );
  assert.match(
    await agent.process("проект Telegram Shop Bot готово: подключить БД"),
    /Задача выполнена в «Telegram Shop Bot»: подключить БД/
  );

  const card = await agent.process("проект Telegram Shop Bot");

  assert.match(card, /Статус: в разработке/);
  assert.match(card, /Стек: Node\.js, Telegraf/);
  assert.match(card, /◻️ настроить оплату/);
  assert.match(card, /✅ подключить БД/);

  assert.match(
    await agent.process("/projects"),
    /Telegram Shop Bot — в разработке \(1\/2 задач\)/
  );

  // Случайное упоминание слова «проект» посреди фразы не должно перехватывать
  // сообщение — только команды, начинающиеся с «проект»/«создай проект» и т.п.
  assert.equal(shouldUseProjectManager("расскажи про мой проект по работе"), false);
  assert.equal(shouldUseProjectManager("calc 2+2"), false);

  assert.match(
    await agent.process("удали проект Telegram Shop Bot"),
    /Проект «Telegram Shop Bot» удалён\./
  );
  assert.match(
    await agent.process("/projects"),
    /Пока нет ни одного проекта/
  );

  await projects.clearProjects(chatId);
});

test("рабочие листы книги не становятся торговыми точками", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-sheets-noise");
  const reportFile = path.join(tempDir, "Т2 7.08-24.08.2026.xlsx");

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const header = [
    "Місце зберігання", "", "Начало", "Приход", "Расход",
    "Отчет о розничных продажах", "Продажа покупателю", "Конец"
  ];
  const units = ["Номенклатура.Артикул", "Номенклатура.Найменування",
    "Кількість", "Кількість", "Кількість", "Кількість", "Кількість", "Кількість"];
  const workbook = new ExcelJS.Workbook();
  const report = workbook.addWorksheet("TDSheet");

  report.addRows([
    header,
    units,
    // Строка-склад открывает блок магазина — по ней вкладка и опознаётся.
    ["Toppers 02 Lviv Staroevreyska", "", 100, 10, 50, 45, 5, 60],
    ["PJ-1", "Змазка pjur Original 30 мл", 10, 0, 8, 8, 0, 2],
    // Артикул без наименования: раньше он открывал новый фантомный магазин,
    // и всё, что ниже, уезжало на него.
    ["SO8611", "", 1, 0, 0, 0, 0, 1],
    ["SX-2", "Лубрикант Swiss Navy 59 мл", 5, 5, 4, 3, 1, 6]
  ]);

  // Рабочий лист человека: та же шапка, но строки-склада нет.
  workbook.addWorksheet("40% і більше").addRows([
    header,
    units,
    ["PJ-1", "Змазка pjur Original 30 мл", 10, 0, 8, 8, 0, 2]
  ]);
  workbook.addWorksheet("Замовлення").addRows([["PJ-1", 5]]);
  await workbook.xlsx.writeFile(reportFile);

  const agent = new Agent();
  const answer = await agent.process(`/excel замовлення ${reportFile}`);
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.ok(fileMatch);

  const out = await new ExcelJS.Workbook().xlsx.readFile(fileMatch[1]);
  const order = out.getWorksheet("Замовлення");
  const skus = [];

  order.eachRow((row, index) => {
    if (index > 1) skus.push(String(row.getCell(1).value));
  });

  // Только два товара реального листа: дубль с «40% і більше» не попал,
  // строка без наименования магазином не стала.
  assert.deepEqual(skus.sort(), ["PJ-1", "SX-2"]);
  assert.doesNotMatch(answer, /40% і більше/);

  fs.rmSync(fileMatch[1], { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("перемещение: колонка нумерации, шапка и итог не портят количества", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-transfer-noise");
  const file = path.join(tempDir, "переміщення з Т11.xlsx");

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const workbook = new ExcelJS.Workbook();

  workbook.addWorksheet("на Т1").addRows([
    ["№", "Артикул", "Кількість"],
    ["1", "SO3206", "12"],
    ["10", "SX0657", "7"],
    // Числовой артикул существует и должен пережить отсев нумерации.
    ["3", "108", "2"],
    ["Разом", "", "21"]
  ]);
  await workbook.xlsx.writeFile(file);

  const agent = new Agent();
  const answer = await agent.process(`/excel перемещение ${file}`);
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  // 12 + 7 + 2: количество берётся справа от артикула, а не первым числом
  // строки (иначе побеждала бы колонка «№»). Шапка и итог отброшены.
  assert.match(answer, /Позиций всего: 3, единиц: 21/);
  assert.ok(fileMatch);

  const out = await new ExcelJS.Workbook().xlsx.readFile(fileMatch[1]);
  const rows = [];

  out.getWorksheet("Перемещение").eachRow((row, index) => {
    if (index > 1) rows.push(row.values.slice(1, 6).map(v => (v == null ? "" : String(v))));
  });

  assert.deepEqual(rows[0], ["Т11", "Т1", "SO3206", "", "12"]);
  assert.deepEqual(rows[2], ["Т11", "Т1", "108", "", "2"]);

  fs.rmSync(fileMatch[1], { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("поиск и фильтр понимают кириллицу и пути с пробелами", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-search-filter");
  // Пробелы в имени — обычное дело для файлов из Telegram.
  const reportFile = path.join(tempDir, "Т1 18.06-5.07.2026.xlsx");

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const workbook = new ExcelJS.Workbook();

  workbook.addWorksheet("TDSheet").addRows([
    ["Місце зберігання", "", "Конец"],
    ["Номенклатура.Артикул", "Номенклатура.Найменування", "Кількість"],
    ["PJ10050", "Універсальна змазка pjur Original 30 мл", 3],
    ["SO1446", "Змазка System JO H2O", 5]
  ]);
  await workbook.xlsx.writeFile(reportFile);

  const agent = new Agent();
  // \b в JS работает только по латинице: раньше «найди» не срезалось и
  // бот искал в таблице фразу «найди pj10050».
  const found = await agent.process(`/excel найди PJ10050 ${reportFile}`);

  assert.match(found, /Найдено строк: 1/);

  // Путь с пробелом раньше попадал внутрь искомой фразы и давал ноль строк.
  const filtered = await agent.process(`/excel оставь только pjur ${reportFile}`);
  const fileMatch = filtered.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.match(filtered, /Оставил только строки/);
  assert.ok(fileMatch);

  fs.rmSync(fileMatch[1], { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("шаблон перемещения строит листы по известным точкам", async () => {
  resetPointRegistry();
  rememberPointName("Toppers 10 Chernivtsi Depo");
  rememberPointName("Toppers 01 Lviv Gnatuka");
  rememberPointName("ХОХО 02 Victoria Gardens");

  const agent = new Agent();
  const answer = await agent.process("шаблон перемещения с Т10");
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.match(answer, /Шаблон перемещения с Т10 готов/);
  assert.ok(fileMatch);

  const workbook = await new ExcelJS.Workbook().xlsx.readFile(fileMatch[1]);
  const names = workbook.worksheets.map(sheet => sheet.name);

  // Лист на каждого получателя, кроме самого источника.
  assert.deepEqual(names, ["Т10 на Т1", "Т10 на Х2"]);
  assert.equal(workbook.worksheets[0].getCell("A1").value, "Артикул");
  assert.equal(workbook.worksheets[0].getCell("B1").value, "Кількість");

  // Заполненный шаблон должен читаться тем же разбором, что и книга,
  // сделанная руками, — иначе круг не замыкается.
  workbook.getWorksheet("Т10 на Т1").addRows([["SO3206", 12], ["PJ10440", 2]]);
  await workbook.xlsx.writeFile(fileMatch[1]);

  const back = await agent.process(`/excel перемещение ${fileMatch[1]}`);
  const backFile = back.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.match(back, /Т10 → Т1: 2 поз\., 14 шт/);
  assert.ok(backFile);

  fs.rmSync(fileMatch[1], { force: true });
  fs.rmSync(backFile[1], { force: true });
  resetPointRegistry();
});

test("перемещение записывается текстом сообщения", async () => {
  resetPointRegistry();

  // Разбор: маршрут строкой, позиции через запятую, количество необязательно.
  const parsed = parseTransferText("Т10 на Т1: SO3206 12, PJ10440 2\nт10 на х2: BIO_2005");

  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], { from: "Т10", to: "Т1", sku: "SO3206", qty: 12 });
  assert.deepEqual(parsed[2], { from: "Т10", to: "Х2", sku: "BIO_2005", qty: null });

  const agent = new Agent();
  const answer = await agent.process("Т10 на Т1: SO3206 12, PJ10440 2");
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.match(answer, /Маршрутов: 1, позиций: 2, единиц: 14/);
  assert.ok(fileMatch);

  fs.rmSync(fileMatch[1], { force: true });
  resetPointRegistry();
});

test("каждая кнопка Excel-меню доходит до Excel-инструмента", () => {
  const ids = EXCEL_ACTIONS.map(action => action.id);

  // callback_data кнопки строится из id — одинаковые id означали бы, что
  // две кнопки делают одно и то же.
  assert.equal(new Set(ids).size, ids.length);

  for (const action of EXCEL_ACTIONS) {
    const kinds = [action.phrase, action.hint, action.menu].filter(Boolean);

    // Ровно один способ поведения: выполнить, подсказать или открыть подменю.
    assert.equal(kinds.length, 1, `${action.id}: ${kinds.length} режим(ов)`);
    assert.ok(action.label.length > 0);

    // Фраза кнопки обязана попадать в Excel-ветку: иначе нажатие уходит в
    // модель, и человек получает болтовню вместо отчёта.
    if (action.phrase) {
      assert.ok(
        shouldUseExcelTool(action.phrase.toLowerCase()),
        `${action.id}: фраза «${action.phrase}» не маршрутизируется в Excel`
      );
    }
  }

  // Условия переноса — второй уровень того же меню.
  assert.ok(EXCEL_ACTIONS.some(action => action.menu === "criteria"));
  assert.ok(CRITERIA_PRESETS.length > 0);
});

test("resolveWebAppUrl picks WEB_APP_URL over RENDER_EXTERNAL_URL and trims a trailing slash", () => {
  const saved = {
    WEB_APP_URL: process.env.WEB_APP_URL,
    RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL
  };

  try {
    delete process.env.WEB_APP_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    assert.equal(resolveWebAppUrl(), null);

    process.env.RENDER_EXTERNAL_URL = "https://ai-agent-artik.onrender.com/";
    assert.equal(resolveWebAppUrl(), "https://ai-agent-artik.onrender.com");

    process.env.WEB_APP_URL = "https://custom.example.com";
    assert.equal(resolveWebAppUrl(), "https://custom.example.com");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("маршрут переноса задаётся списками и исключениями", () => {
  resetPointRegistry();
  rememberPointName("Toppers 01 Lviv Gnatuka");
  rememberPointName("ХОХО 02 Victoria Gardens");

  const query = "перенеси с Т1, Т7 и Т9 на Т10 кроме Т5 где реализация<20%";

  // «на» закрывает перечисление источников: без этого Т10 попадала и туда.
  assert.deepEqual(parseSourcePoints(query), ["Т1", "Т7", "Т9"]);
  assert.deepEqual(parseDestinationPoints(query), ["Т10"]);
  assert.deepEqual(parseExcludedPoints(query), ["Т5"]);

  // Названия магазинов из отчёта работают наравне с кодами.
  assert.deepEqual(
    parseSourcePoints("перенеси с Toppers 1 на ХОХО 2 где продаж<3"),
    ["Т1"]
  );
  assert.deepEqual(
    parseDestinationPoints("перенеси с Toppers 1 на ХОХО 2 где продаж<3"),
    ["Х2"]
  );

  resetPointRegistry();
});

test("потребность получателя закрывается один раз", () => {
  const stock = (code, extra) => ({
    code,
    point: code,
    sku: "X",
    name: "товар",
    retail: 0,
    wholesale: 0,
    end: 0,
    available: 0,
    expense: 0,
    sellThrough: 0,
    stockDays: 0,
    need: 0,
    ...extra
  });
  const bySku = new Map([
    ["X", new Map([
      ["Т1", stock("Т1", { end: 20, available: 20, expense: 1, sellThrough: 0.05, stockDays: 999 })],
      ["Т2", stock("Т2", { end: 20, available: 20, expense: 1, sellThrough: 0.05, stockDays: 999 })],
      ["Т3", stock("Т3", { retail: 4, available: 4, expense: 4, sellThrough: 1, need: 8 })]
    ])]
  ]);

  const plan = planTransfers(bySku, {
    sources: [],
    destinations: [],
    excluded: [],
    maxStockDays: 30,
    minBatch: 2,
    exclusions: [],
    isSource: item => item.sellThrough < 0.4
  });
  const units = plan.lines.reduce((sum, line) => sum + line.qty, 0);

  // Два «мёртвых» источника не должны закрыть одну нехватку дважды:
  // раньше получателю везли 16 при потребности 8.
  assert.equal(units, 8);
});

test("одна точка в нескольких выгрузках считается один раз", () => {
  const record = (file, point, sku) => ({
    file,
    point,
    sku,
    name: "товар",
    retail: 1,
    wholesale: 0,
    end: 1,
    start: 1,
    receipt: 0,
    expense: 1,
    cells: {}
  });

  const dir = path.join(process.cwd(), "test", ".tmp-dup-points");

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const older = path.join(dir, "старая.csv");
  const newer = path.join(dir, "свежая.csv");

  fs.writeFileSync(older, "a");
  fs.writeFileSync(newer, "b");
  // Свежесть считается по времени файла, поэтому проставляем его явно.
  fs.utimesSync(older, new Date(2020, 0, 1), new Date(2020, 0, 1));
  fs.utimesSync(newer, new Date(2030, 0, 1), new Date(2030, 0, 1));

  const fresh = keepFreshestPointRecords(
    [
      record("старая.csv", "Toppers 01 Lviv Gnatuka", "A"),
      record("свежая.csv", "Т1", "A"),
      record("свежая.csv", "Т2", "B")
    ],
    [older, newer]
  );

  // «Toppers 01 Lviv Gnatuka» и «Т1» — один магазин: остаётся свежая выгрузка.
  assert.equal(fresh.records.length, 2);
  assert.deepEqual(fresh.records.map(item => item.sku), ["A", "B"]);
  assert.equal(fresh.skipped.length, 1);
  assert.equal(fresh.skipped[0].point, "Т1");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseNumber не теряет числа с разделителями тысяч", () => {
  assert.equal(parseNumber("1 234"), 1234);
  // Раньше «1,234,567» превращалось в null — то есть в ноль в отчёте.
  assert.equal(parseNumber("1,234,567"), 1234567);
  // Одиночная запятая в выгрузках 1С — десятичный разделитель.
  assert.equal(parseNumber("3,5"), 3.5);
  assert.equal(parseNumber("1.234"), 1.234);
});

test("каждая команда из справки действительно доходит до Excel", async () => {
  // Справка — обещание пользователю. Если пример из неё уходит не в тот
  // модуль, человек получает не то, что просил: «найди PJ10050» без слова
  // «таблица» бот раньше отправлял в интернет и пересказывал описание товара.
  const documented = [
    "заказ поставщику",
    "заказ только презервативы и лубриканты",
    "заказ поставщику весь товар",
    "перенеси где реализация<20%",
    "перенеси с Т1, Т7 и Т9 на Т10 где остаток>3",
    "перенеси с Т1 на Т9 и Т10 кроме Т5 где запас>60",
    "развези по продажам",
    "перемещение по нулевым продажам",
    "непроданное",
    "шаблон перемещения с Т10",
    "Т10 на Т1: SO3206 12, PJ10440 2",
    "оставь только pjur",
    "удали всё кроме презерватив",
    "найди PJ10050 в таблице",
    "аналитика по excel-файлу",
    "покажи листы",
    "поменяй артикул A123 на B456 в data/ostatki.xlsx"
  ];

  for (const command of documented) {
    assert.ok(
      shouldUseExcelTool(command.toLowerCase()),
      `«${command}» не маршрутизируется в Excel`
    );
  }

  const help = await excelTool.run("/excel");

  // Каждая команда должна быть в справке — иначе о ней никто не узнает.
  for (const command of documented) {
    const head = command.split(/[<:]/)[0].trim();

    assert.ok(
      help.includes(head),
      `«${head}» не описан в справке`
    );
  }

  // Справка должна умещаться в одно сообщение Telegram.
  assert.ok(help.length < 3900, `справка выросла до ${help.length} символов`);
});

test("agent explains why a T1 report produced no order", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-t1-diag");
  const reportFile = path.join(tempDir, "t1-report.xlsx");

  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });

  await writeT1ReportWorkbook(reportFile);

  const agent = new Agent();
  // В отчёте есть товары, но задан префикс, которого нет ни у одного артикула.
  const answer = await agent.process(
    `/excel замовлення prefixes=QQ ${reportFile}`
  );

  assert.match(answer, /Замовлення Т1 не сформировано/);
  assert.match(answer, /ни один артикул не начинается с QQ/);
  assert.doesNotMatch(answer, /Excel-файл:/);

  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });
});

/**
 * Мини-отчёт движения: строка-склад + товары. Колонки задаём как есть, чтобы
 * проверить и объединение разных раскладок между файлами.
 */
async function writeSalesReportWorkbook(filePath, section, header, productRows) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("TDSheet");

  worksheet.addRow(header);
  worksheet.addRow(["Номенклатура.Артикул", "Номенклатура.Найменування"]);
  worksheet.addRow([section, "", ...header.slice(2).map(() => 0)]);
  productRows.forEach(row => worksheet.addRow(row));

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await workbook.xlsx.writeFile(filePath);
}

test("dead-stock report merges files and keeps only unsold products", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-dead");
  const fileA = path.join(tempDir, "t1-report.xlsx");
  const fileB = path.join(tempDir, "t2-report.xlsx");

  fs.rmSync(tempDir, { recursive: true, force: true });

  // A: розница/опт по колонкам 7/8. SKU-1 продан в рознице, SKU-2 — ноль.
  await writeSalesReportWorkbook(
    fileA,
    "Точка А",
    ["Місце зберігання", "", "Начало", "Приход", "Расход",
      "Отчет о розничных продажах", "Продажа покупателю", "Конец"],
    [
      ["SKU-1", "Проданный в рознице", 5, 0, 2, 2, 0, 3],
      ["SKU-2", "Мёртвый в А", 4, 0, 0, 0, 0, 4],
      ["SKU-3", "Только опт", 6, 0, 1, 0, 1, 5]
    ]
  );

  // B: другая раскладка (лишняя колонка «Списание запасов»). SKU-2 опять ноль,
  // но продан оптом -> из списка вылетает. SKU-4 мёртв только в B.
  await writeSalesReportWorkbook(
    fileB,
    "Точка Б",
    ["Місце зберігання", "", "Начало", "Приход", "Расход", "Списание запасов",
      "Отчет о розничных продажах", "Продажа покупателю", "Конец"],
    [
      ["SKU-2", "Мёртвый в А, опт в Б", 3, 0, 1, 0, 0, 1, 2],
      ["SKU-4", "Мёртвый в Б", 2, 0, 0, 0, 0, 0, 2]
    ]
  );

  const agent = new Agent();
  const answer = await agent.process(`/excel непроданное ${fileA} ${fileB}`);
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.match(answer, /Отчёт по непроданному товару готов/);
  assert.ok(fileMatch);

  const workbook = await new ExcelJS.Workbook().xlsx.readFile(fileMatch[1]);
  const worksheet = workbook.getWorksheet("Непродано");
  const skuColumn = worksheet.getRow(1).values.indexOf("Артикул");
  const skus = [];
  worksheet.eachRow((row, index) => {
    if (index > 1) skus.push(row.getCell(skuColumn).value);
  });

  // SKU-2 продан оптом в Б -> исключён. SKU-1/SKU-3 продавались -> исключены.
  assert.deepEqual(skus.sort(), ["SKU-4"]);
  // Объединение раскладок: колонка из файла Б попала в шапку.
  assert.ok(worksheet.getRow(1).values.includes("Списание запасов"));

  fs.rmSync(fileMatch[1], { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("extractKeepPhrase strips the command and file path", () => {
  assert.equal(extractKeepPhrase("оставь только pjur data/t1.xlsx"), "pjur");
  assert.equal(extractKeepPhrase("/excel удали всё кроме \"Obsessive\" a.xlsx"), "Obsessive");
  assert.equal(extractKeepPhrase("оставить только Sorry i am virgin"), "Sorry i am virgin");
  assert.equal(extractKeepPhrase("keep only pjur"), "pjur");
  // без искомого текста — пусто, бот попросит уточнить
  assert.equal(extractKeepPhrase("оставь только data/t1.xlsx"), "");
});

test("filter keeps only rows whose name contains the phrase", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-filter");
  const reportFile = path.join(tempDir, "t1-report.xlsx");

  fs.rmSync(tempDir, { recursive: true, force: true });
  await writeSalesReportWorkbook(
    reportFile,
    "Точка А",
    ["Місце зберігання", "", "Начало", "Расход",
      "Отчет о розничных продажах", "Конец"],
    [
      ["PJ10050", "Змазка pjur Original 30 мл", 3, 1, 1, 2],
      ["PJ10160", "Змазка pjur Woman 30 мл", 4, 2, 2, 2],
      ["SO5671", "Лубрикант Swiss Navy 946 мл", 5, 0, 0, 5],
      ["108", "шкарпетки Twerk 35-39", 1, 0, 0, 1]
    ]
  );

  const agent = new Agent();
  const answer = await agent.process(`/excel оставь только pjur ${reportFile}`);
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.match(answer, /Оставил только строки с «pjur»/);
  assert.match(answer, /Оставлено строк: 2/);
  assert.ok(fileMatch);

  const workbook = await new ExcelJS.Workbook().xlsx.readFile(fileMatch[1]);
  const worksheet = workbook.getWorksheet("Отфильтровано");
  const headerValues = worksheet.getRow(1).values;
  const nameColumn = headerValues.findIndex(
    value => /найменування|наименование/i.test(String(value || ""))
  );
  const names = [];
  worksheet.eachRow((row, index) => {
    if (index > 1) names.push(row.getCell(nameColumn).value);
  });

  assert.equal(names.length, 2);
  assert.ok(names.every(name => /pjur/i.test(String(name))));
  // все исходные колонки на месте
  assert.ok(headerValues.includes("Конец"));

  fs.rmSync(fileMatch[1], { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("transfer doc flattens per-sheet SKU lists into one table", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-transfer");
  const file = path.join(tempDir, "переміщення з Т11.xlsx");

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const workbook = new ExcelJS.Workbook();
  const sheetA = workbook.addWorksheet("на Т9");
  sheetA.addRows([["SX0657"], ["SO4837", "пробка"]]);
  const sheetB = workbook.addWorksheet("не знаю");
  // кривая строка: название в колонке A, артикул в колонке D
  sheetB.addRows([["PJ11290", "анал 250"], ["воскова свічка Art of Sex M", "", "", "SO5955"]]);
  await workbook.xlsx.writeFile(file);

  const agent = new Agent();
  const answer = await agent.process(`/excel перемещение ${file}`);
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.match(answer, /Документ перемещения готов/);
  assert.match(answer, /Со склада: Т11/);
  assert.ok(fileMatch);

  const out = await new ExcelJS.Workbook().xlsx.readFile(fileMatch[1]);
  const sheet = out.getWorksheet("Перемещение");
  const rows = [];
  sheet.eachRow((row, index) => {
    if (index > 1) rows.push(row.values.slice(1, 7).map(v => (v == null ? "" : String(v))));
  });

  // [Со склада, На склад, Артикул, Название, Кол-во, Примечание]
  assert.deepEqual(rows[0], ["Т11", "Т9", "SX0657", "", "", ""]);
  assert.deepEqual(rows[1], ["Т11", "Т9", "SO4837", "", "", "пробка"]);
  assert.deepEqual(rows[2], ["Т11", "не знаю", "PJ11290", "", "", "анал 250"]);
  // артикул вытащен из колонки D, имя ушло в примечание
  assert.deepEqual(rows[3], ["Т11", "не знаю", "SO5955", "", "", "воскова свічка Art of Sex M"]);

  fs.rmSync(fileMatch[1], { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("transfer doc reads the route from sheet names and picks up quantities", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-transfer-routes");

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  // Форма «Т10 на Т1»: и источник, и получатель в имени листа, рядом с
  // артикулом — количество.
  const fromT10 = path.join(tempDir, "Переміщення з Т10.xlsx");
  const bookA = new ExcelJS.Workbook();
  bookA.addWorksheet("т10 на Т1").addRows([["BIO_2005", "1"], ["SX2394", "2"]]);
  bookA.addWorksheet("т10 на т9").addRows([["SO1111", "3"]]);
  await bookA.xlsx.writeFile(fromT10);

  // Форма наоборот: листы названы источниками, получатель — в имени файла.
  const toT1 = path.join(tempDir, "переміщення на Т1_з Т2_з Т7.xlsx");
  const bookB = new ExcelJS.Workbook();
  bookB.addWorksheet("з т7 ").addRows([["SO2928", "1"]]);
  bookB.addWorksheet("з т2").addRows([["PJ10440", "2"]]);
  await bookB.xlsx.writeFile(toT1);

  const agent = new Agent();
  const answerA = await agent.process(`/excel перемещение ${fromT10}`);
  const fileA = answerA.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.match(answerA, /Со склада: Т10/);
  assert.match(answerA, /Т10 → Т1: 2 поз\., 3 шт/);
  assert.match(answerA, /Т10 → Т9: 1 поз\., 3 шт/);
  assert.ok(fileA);

  const outA = await new ExcelJS.Workbook().xlsx.readFile(fileA[1]);
  const rowsA = [];
  outA.getWorksheet("Перемещение").eachRow((row, index) => {
    if (index > 1) rowsA.push(row.values.slice(1, 6).map(v => (v == null ? "" : String(v))));
  });

  // [Со склада, На склад, Артикул, Название, Кол-во]
  assert.deepEqual(rowsA[0], ["Т10", "Т1", "BIO_2005", "", "1"]);
  assert.deepEqual(rowsA[2], ["Т10", "Т9", "SO1111", "", "3"]);

  const answerB = await agent.process(`/excel перемещение ${toT1}`);
  const fileB = answerB.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  // Лист «з т7» — это источник, а получатель Т1 назван только в имени файла.
  assert.match(answerB, /Т7 → Т1: 1 поз\., 1 шт/);
  assert.match(answerB, /Т2 → Т1: 1 поз\., 2 шт/);
  assert.ok(fileB);

  fs.rmSync(fileA[1], { force: true });
  fs.rmSync(fileB[1], { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("allocateProportionally splits without losing or inventing units", () => {
  // 5 единиц между продажами 6 и 2: 3.75 / 1.25 -> 4 и 1
  assert.deepEqual(allocateProportionally(5, [6, 2]), [4, 1]);
  // одна единица достаётся лучшему по продажам
  assert.deepEqual(allocateProportionally(1, [6, 2]), [1, 0]);
  // сумма всегда равна исходному остатку
  const split = allocateProportionally(7, [1, 1, 1]);
  assert.equal(split.reduce((sum, value) => sum + value, 0), 7);
  // получатели без продаж не получают ничего
  assert.deepEqual(allocateProportionally(4, [0, 0]), [0, 0]);
});

test("redistribution moves dead stock to the stores that sell it", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-redis");
  const header = ["Місце зберігання", "", "Начало", "Расход",
    "Отчет о розничных продажах", "Продажа покупателю", "Конец"];

  fs.rmSync(tempDir, { recursive: true, force: true });

  const t1 = path.join(tempDir, "t1.xlsx");
  const t5 = path.join(tempDir, "t5.xlsx");
  const t7 = path.join(tempDir, "t7.xlsx");

  // Т1 продаёт A (6 шт), Б лежит мёртвым. Т5 мёртв по обоим. Т7 продаёт A (2 шт).
  await writeSalesReportWorkbook(t1, "Т1", header, [
    ["SKU-A", "Товар А", 8, 6, 6, 0, 2],
    ["SKU-B", "Товар Б", 4, 0, 0, 0, 4]
  ]);
  await writeSalesReportWorkbook(t5, "Т5", header, [
    ["SKU-A", "Товар А", 5, 0, 0, 0, 5],
    ["SKU-B", "Товар Б", 3, 0, 0, 0, 3]
  ]);
  await writeSalesReportWorkbook(t7, "Т7", header, [
    ["SKU-A", "Товар А", 3, 2, 2, 0, 1]
  ]);

  const agent = new Agent();
  const answer = await agent.process(
    `/excel перемещение по нулевым продажам ${t1} ${t5} ${t7}`
  );
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.match(answer, /Перемещение по нулевым продажам готово/);
  // 5 штук из Т5 делятся 6:2 между Т1 и Т7 -> 4 и 1
  assert.match(answer, /Строк перемещения: 2, единиц: 5/);
  // SKU-B не продаётся нигде -> пропущен
  assert.match(answer, /Пропущено \(не продаётся нигде\): 1/);
  assert.ok(fileMatch);

  const workbook = await new ExcelJS.Workbook().xlsx.readFile(fileMatch[1]);
  const worksheet = workbook.getWorksheet("Перемещение");
  const rows = [];
  worksheet.eachRow((row, index) => {
    if (index > 1) rows.push(row.values.slice(1, 8));
  });

  // [Со склада, На склад, Артикул, Название, Кол-во, Остаток источника, Продажи получателя]
  assert.deepEqual(rows[0], ["Т5", "Т1", "SKU-A", "Товар А", 4, 5, 6]);
  assert.deepEqual(rows[1], ["Т5", "Т7", "SKU-A", "Товар А", 1, 5, 2]);

  fs.rmSync(fileMatch[1], { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("every criteria button phrase routes to the criteria transfer", () => {
  assert.ok(CRITERIA_PRESETS.length > 0);

  for (const preset of CRITERIA_PRESETS) {
    const lower = preset.phrase.toLowerCase();

    // Кнопка бесполезна, если её фраза не доедет до excel-инструмента или
    // доедет без условия — тогда ответ уйдёт в модель или в другую команду.
    assert.ok(shouldUseExcelTool(lower), `не маршрутизируется: ${preset.phrase}`);
    assert.ok(
      parseCriteria(preset.phrase).length > 0,
      `условие не разобрано: ${preset.phrase}`
    );
    assert.ok(
      Buffer.byteLength(`crit:${preset.id}`, "utf8") <= 64,
      `callback_data длиннее 64 байт: ${preset.id}`
    );
  }
});

test("parseSourcePoint is optional and tolerates latin store codes", () => {
  // Основной режим — без магазина: считаем по всем точкам.
  assert.equal(parseSourcePoint("перенеси где реализация<20%"), null);
  assert.equal(parseSourcePoint("перенеси с Т5 где реализация<20%"), "Т5");
  assert.equal(parseSourcePoint("перенеси с т5 где реализация<20%"), "Т5");
  // Латинскую раскладку приводим к кириллице — точки названы кириллицей.
  assert.equal(parseSourcePoint("перенеси с t5 где реализация<20%"), "Т5");
  assert.equal(parseSourcePoint("перенеси из x2 где реализация<20%"), "Х2");
});

test("parseCriteria reads thresholds and normalizes percents", () => {
  assert.deepEqual(
    parseCriteria("перенеси с Т5 реализация<20%").map(item =>
      [item.field, item.op, item.value]
    ),
    [["sellThrough", "<", 0.2]]
  );
  // «20» без знака процента для реализации значит те же 20%, «0.2» — уже доля.
  assert.equal(parseCriteria("реализация<20")[0].value, 0.2);
  assert.equal(parseCriteria("реализация<0.2")[0].value, 0.2);
  // Словесные операторы и несколько условий сразу.
  assert.deepEqual(
    parseCriteria("остаток больше 10 продаж меньше 3").map(item =>
      [item.field, item.op, item.value]
    ),
    [["retail", "<", 3], ["end", ">", 10]]
  );
  assert.deepEqual(parseCriteria("перенеси всё что залежалось"), []);
});

test("criteria transfer moves low sell-through stock off the named store", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-criteria");
  const header = ["Місце зберігання", "", "Начало", "Приход", "Расход",
    "Отчет о розничных продажах", "Продажа покупателю", "Конец"];

  fs.rmSync(tempDir, { recursive: true, force: true });

  const t1 = path.join(tempDir, "t1.xlsx");
  const t5 = path.join(tempDir, "t5.xlsx");
  const t7 = path.join(tempDir, "t7.xlsx");

  // Т5: PJ-1 реализация 10% (2 из 20) — под условие; SO-2 80% — мимо.
  await writeSalesReportWorkbook(t5, "Т5", header, [
    ["PJ-1", "Гель", 20, 0, 2, 2, 0, 18],
    ["SO-2", "Пробка", 10, 0, 8, 8, 0, 2]
  ]);
  await writeSalesReportWorkbook(t1, "Т1", header, [
    ["PJ-1", "Гель", 10, 0, 6, 6, 0, 4]
  ]);
  await writeSalesReportWorkbook(t7, "Т7", header, [
    ["PJ-1", "Гель", 5, 0, 2, 2, 0, 3]
  ]);

  const agent = new Agent();
  const answer = await agent.process(
    `/excel перенеси с Т5 где реализация<20% ${t1} ${t5} ${t7}`
  );
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.match(answer, /Перенос по критериям готов/);
  assert.match(answer, /Условие: Реализация < 20%/);
  assert.match(answer, /Со склада: Т5/);
  // Т1 продаёт 6 шт/период, остаток 4 -> до 36 дней покрытия не хватает 8 шт.
  // Т7 не хватает всего 1 шт. — это меньше минимальной партии, он пропущен.
  // Остальные 10 шт. остаются на Т5: везём по потребности, а не подчистую.
  assert.match(answer, /Строк переноса: 1, единиц: 8/);
  assert.match(answer, /осталось на источниках: 10/);
  assert.ok(fileMatch);

  const workbook = await new ExcelJS.Workbook().xlsx.readFile(fileMatch[1]);
  const worksheet = workbook.getWorksheet("Перенос");
  const rows = [];
  worksheet.eachRow((row, index) => {
    if (index > 1) rows.push(row.values.slice(1, 8));
  });

  // [Со склада, На склад, Артикул, Название, Кол-во, Реализация, Остаток]
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], ["Т5", "Т1", "PJ-1", "Гель", 8, 0.1, 18]);

  fs.rmSync(fileMatch[1], { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("point registry maps store spellings onto one code", () => {
  // Одна и та же точка приходит боту тремя способами: строкой-складом из
  // выгрузки, кодом из имени файла и текстом запроса.
  assert.equal(normalizePointCode("Toppers 01 Lviv Gnatuka"), "Т1");
  assert.equal(normalizePointCode("toppers 1"), "Т1");
  assert.equal(normalizePointCode("t1"), "Т1");
  assert.equal(normalizePointCode("ХОХО 02 Victoria Gardens"), "Х2");
  assert.equal(normalizePointCode("x2"), "Х2");
  // Точка без номера получает код через дефис и переживает обратный разбор.
  assert.equal(normalizePointCode("Toppers Інстаграм"), "Т-ІНСТАГРАМ");
  assert.equal(normalizePointCode("Т-ІНСТАГРАМ"), "Т-ІНСТАГРАМ");
  // Служебные строки отчёта точками не считаются.
  assert.equal(normalizePointCode("Разом"), null);
  assert.equal(normalizePointCode("Місце зберігання"), null);
  // Сортировка по номеру, а не по тексту: Т2 раньше Т10.
  assert.ok(comparePointCodes("Т2", "Т10") < 0);
  assert.ok(comparePointCodes("Т12", "Х1") < 0);
});

test("query parsing finds source and destination stores", () => {
  assert.equal(parseSourcePoint("перенеси с toppers 1 где реализация<20%"), "Т1");
  assert.equal(parseSourcePoint("перенеси со склада=Т5 где остаток>3"), "Т5");
  assert.equal(parseDestinationPoint("перенеси с т1 на т9 где остаток>3"), "Т9");
  assert.equal(parseDestinationPoint("перенеси с т1 где остаток>3"), null);
  // «на 2 периода» — не склад.
  assert.equal(parseDestinationPoint("перенеси где остаток>3 на 2 периода"), null);
});

test("criteria transfer splits scarce stock by receiver need", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-criteria-split");
  const header = ["Місце зберігання", "", "Начало", "Приход", "Расход",
    "Отчет о розничных продажах", "Продажа покупателю", "Конец"];

  fs.rmSync(tempDir, { recursive: true, force: true });

  const t1 = path.join(tempDir, "t1.xlsx");
  const t5 = path.join(tempDir, "t5.xlsx");
  const t7 = path.join(tempDir, "t7.xlsx");

  // На Т5 лежит 6 шт., а получателям нужно 18 — это режим дефицита.
  await writeSalesReportWorkbook(t5, "Т5", header, [
    ["PJ-1", "Гель", 30, 0, 2, 2, 0, 6]
  ]);
  await writeSalesReportWorkbook(t1, "Т1", header, [
    ["PJ-1", "Гель", 6, 0, 6, 6, 0, 0]
  ]);
  await writeSalesReportWorkbook(t7, "Т7", header, [
    ["PJ-1", "Гель", 3, 0, 3, 3, 0, 0]
  ]);

  const agent = new Agent();
  const answer = await agent.process(
    `/excel перенеси с Т5 где реализация<20% ${t1} ${t5} ${t7}`
  );
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  // Потребности 12 и 6 при запасе 6 -> делим пропорционально: 4 и 2.
  assert.match(answer, /Строк переноса: 2, единиц: 6/);
  assert.match(answer, /осталось на источниках: 0/);
  assert.ok(fileMatch);

  const workbook = await new ExcelJS.Workbook().xlsx.readFile(fileMatch[1]);
  const worksheet = workbook.getWorksheet("Перенос");
  const rows = [];
  worksheet.eachRow((row, index) => {
    if (index > 1) rows.push(row.values.slice(1, 6));
  });

  assert.deepEqual(rows[0], ["Т5", "Т1", "PJ-1", "Гель", 4]);
  assert.deepEqual(rows[1], ["Т5", "Т7", "PJ-1", "Гель", 2]);

  fs.rmSync(fileMatch[1], { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("sheet commands are parsed, and neighbours are left alone", () => {
  assert.deepEqual(parseSheetOperations("покажи листы"), [{ kind: "list" }]);
  assert.deepEqual(
    parseSheetOperations("создай листы Т9, Т10 и Т11"),
    [
      { kind: "create", name: "Т9" },
      { kind: "create", name: "Т10" },
      { kind: "create", name: "Т11" }
    ]
  );
  // Имя в кавычках может содержать пробелы.
  assert.deepEqual(
    parseSheetOperations('создай ещё один лист "на Т9"'),
    [{ kind: "create", name: "на Т9" }]
  );
  assert.deepEqual(
    parseSheetOperations("переименуй лист Т5 в Т9"),
    [{ kind: "rename", name: "Т5", target: "Т9" }]
  );
  assert.deepEqual(
    parseSheetOperations("продублируй лист Т5"),
    [{ kind: "copy", name: "Т5", target: undefined }]
  );
  // Две операции подряд: союз не должен прилипнуть к имени листа.
  assert.deepEqual(
    parseSheetOperations("удали лист Т5 и создай лист Т9"),
    [{ kind: "delete", name: "Т5" }, { kind: "create", name: "Т9" }]
  );
  // Глагол без слова «лист» — это другая команда, не трогаем.
  assert.deepEqual(parseSheetOperations("удали всё кроме pjur"), []);
  assert.deepEqual(parseSheetOperations("поменяй артикул A123 на B456"), []);
});

test("sheet operations write a new workbook and keep the source intact", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-sheets");
  const source = path.join(tempDir, "kniga.xlsx");

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("з т5").addRow(["SO-1", "Гель"]);
  workbook.addWorksheet("з Т3").addRow(["PJ-2", "Змазка"]);
  workbook.addWorksheet("з т8").addRow(["SX-3", "Ошийник"]);
  await workbook.xlsx.writeFile(source);

  const agent = new Agent();
  const answer = await agent.process(
    `/excel удали лист т5 и создай лист "на Т9" ${source}`
  );
  const fileMatch = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  assert.match(answer, /Листы обновлены/);
  // «т5» находится через реестр точек, хотя лист назван «з т5».
  assert.match(answer, /удалён лист «з т5»/);
  assert.match(answer, /создан лист «на Т9»/);
  assert.ok(fileMatch);

  const result = new ExcelJS.Workbook();
  await result.xlsx.readFile(fileMatch[1]);
  assert.deepEqual(
    result.worksheets.map(sheet => sheet.name),
    ["з Т3", "з т8", "на Т9"]
  );

  // Исходник остался нетронутым: удаление листа необратимо.
  const original = new ExcelJS.Workbook();
  await original.xlsx.readFile(source);
  assert.deepEqual(
    original.worksheets.map(sheet => sheet.name),
    ["з т5", "з Т3", "з т8"]
  );

  fs.rmSync(fileMatch[1], { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("the last sheet of a workbook cannot be deleted", async () => {
  const tempDir = path.join(process.cwd(), "test", ".tmp-sheets-last");
  const source = path.join(tempDir, "odin-list.xlsx");

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Т1").addRow(["SO-1", "Гель"]);
  await workbook.xlsx.writeFile(source);

  const agent = new Agent();
  const answer = await agent.process(`/excel удали лист Т1 ${source}`);

  assert.match(answer, /Ничего не изменил/);
  assert.match(answer, /последний лист/);
  assert.ok(!/^Excel-файл:/m.test(answer));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("file pool is scoped to the chat that uploaded the files", () => {
  const own = path.join(process.cwd(), "data", "telegram", "test-chat-own");
  const other = path.join(process.cwd(), "data", "telegram", "test-chat-other");

  fs.mkdirSync(own, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(own, "moi.csv"), "Артикул;Конец\nPJ-1;5\n");
  fs.writeFileSync(path.join(other, "chuzhoi.csv"), "Артикул;Конец\nSX-9;7\n");

  try {
    const mine = discoverChatFiles("test-chat-own");

    assert.deepEqual(mine, ["data/telegram/test-chat-own/moi.csv"]);
    assert.ok(!mine.some(file => file.includes("test-chat-other")));

    // Автопоиск без чата не должен вытаскивать чужие загрузки.
    assert.ok(
      !discoverChatFiles(null).some(file => file.includes("data/telegram/"))
    );
  } finally {
    fs.rmSync(own, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("memory does not drag bot-generated workbooks back into the pool", () => {
  const dir = path.join(process.cwd(), "data", "telegram", "test-chat-memory");

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "t1.csv"), "Артикул;Конец\nPJ-1;5\n");
  fs.writeFileSync(path.join(dir, "sales-order-t1.csv"), "Артикул;Конец\nPJ-1;5\n");
  // Человек называет свои выгрузки «замовлення …» — это НЕ книга бота:
  // свои бот пишет латиницей (sales-order-…), и раньше это слово в имени
  // выбрасывало живой файл из пула.
  fs.writeFileSync(
    path.join(dir, "замовлення 22.07 Т3.csv"),
    "Артикул;Конец\nPJ-1;5\n"
  );

  try {
    const files = resolveFiles({
      query: "перенеси где реализация<20%",
      memories: [
        "Excel файл загружен: data/telegram/test-chat-memory/t1.csv",
        "Excel файл загружен: data/telegram/test-chat-memory/sales-order-t1.csv"
      ],
      files: [],
      chatId: "test-chat-memory"
    });

    assert.deepEqual(files, ["data/telegram/test-chat-memory/t1.csv"]);

    // Автопоиск по чату видит файл человека и не видит книгу бота.
    const discovered = resolveFiles({
      query: "перенеси где реализация<20%",
      memories: [],
      files: [],
      chatId: "test-chat-memory"
    });

    assert.ok(discovered.some(item => item.includes("замовлення 22.07 Т3.csv")));
    assert.ok(!discovered.some(item => item.includes("sales-order-t1.csv")));

    // Явно названный в запросе файл фильтр не трогает.
    assert.ok(
      resolveFiles({
        query: "перенеси data/telegram/test-chat-memory/sales-order-t1.csv",
        memories: [],
        files: [],
        chatId: "test-chat-memory"
      }).includes("data/telegram/test-chat-memory/sales-order-t1.csv")
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
