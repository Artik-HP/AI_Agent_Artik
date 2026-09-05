import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import Agent, { shouldUseExcelTool } from "../src/agent.js";
import * as memory from "../src/memory.js";
import { CRITERIA_PRESETS, sanitizeFileName } from "../src/telegram.js";
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

test("agent creates image generation links", async () => {
  const agent = new Agent();
  const answer = await agent.process("/draw neon cat");

  assert.match(answer, /Картинка готова:/);
  assert.match(answer, /https:\/\/image\.pollinations\.ai\/prompt\/neon%20cat/);
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
    // Подходит: префикс SO, есть расход, запас в норме.
    ["SO-1001", "Товар SO швидкий", 8, 0, 0, 0, 6, 6, 0, 0, 2],
    // Отсеивается: затоварен (оборот 20 периодов -> > maxStockDays).
    ["SO-1002", "Товар SO затоварений", 40, 0, 0, 0, 2, 2, 0, 0, 38],
    // Подходит: префикс SX.
    ["SX-2001", "Товар SX", 5, 5, 0, 5, 4, 3, 1, 0, 6],
    // Отсеивается: нет продаж за период (расход = 0).
    ["AD-3001", "Товар AD без продажу", 3, 0, 0, 0, 0, 0, 0, 0, 3],
    // Отсеивается: чужой префикс.
    ["ZZ-9001", "Чужий бренд", 5, 0, 0, 0, 5, 5, 0, 0, 0],
    // Подходит: префикс PJ.
    ["PJ-4001", "Товар PJ", 4, 0, 0, 0, 3, 3, 0, 0, 1]
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

  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });

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

  const agent = new Agent();
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
  assert.match(answer, /Позиции: 3/);
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
  // PJ-4001, SX-2001, SO-1001. SO-1002 отсеян по реализации <40%, AD-3001 без
  // продаж, ZZ-9001 с чужим префиксом.
  assert.match(answer, /Позиции: 3/);
  assert.match(answer, /Рекомендовано к заказу: 17 ед\./);
  assert.match(answer, /<40% реализации — 1/);
  assert.ok(fileMatch);
  assert.ok(fs.existsSync(fileMatch[1]));

  const workbook = await new ExcelJS.Workbook().xlsx.readFile(fileMatch[1]);
  const worksheet = workbook.getWorksheet("Замовлення");

  // Сортировка по рангу префикса из config.yaml: PJ -> SX -> SO.
  assert.equal(worksheet.getCell("A2").value, "PJ-4001");
  assert.equal(worksheet.getCell("A3").value, "SX-2001");
  assert.equal(worksheet.getCell("A4").value, "SO-1001");
  assert.match(worksheet.getCell("M2").value.formula, /ROUNDUP/);
  // baseline computeRecommendedOrder = ceil(Расход*2 - Конец):
  // PJ ceil(3*2-1)=5, SX ceil(4*2-6)=2, SO ceil(6*2-2)=10.
  assert.equal(worksheet.getCell("M2").value.result, 5);
  assert.equal(worksheet.getCell("M3").value.result, 2);
  assert.equal(worksheet.getCell("M4").value.result, 10);

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
  // 18 штук делятся 6:2 между Т1 и Т7 -> 14 и 4. SO-2 отсеян по реализации.
  assert.match(answer, /Строк переноса: 2, единиц: 18/);
  assert.ok(fileMatch);

  const workbook = await new ExcelJS.Workbook().xlsx.readFile(fileMatch[1]);
  const worksheet = workbook.getWorksheet("Перенос");
  const rows = [];
  worksheet.eachRow((row, index) => {
    if (index > 1) rows.push(row.values.slice(1, 8));
  });

  // [Со склада, На склад, Артикул, Название, Кол-во, Реализация, Остаток]
  assert.deepEqual(rows[0], ["Т5", "Т1", "PJ-1", "Гель", 14, 0.1, 18]);
  assert.deepEqual(rows[1], ["Т5", "Т7", "PJ-1", "Гель", 4, 0.1, 18]);

  fs.rmSync(fileMatch[1], { force: true });
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
