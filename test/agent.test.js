import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import Agent from "../src/agent.js";
import * as memory from "../src/memory.js";
import {
  extractNamedSpreadsheetPaths,
  extractSpreadsheetPaths
} from "../src/tools/excel/reader.js";

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

async function writeT1ReportWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("TDSheet");

  worksheet.addRows([
    [
      "Місце зберігання",
      "",
      "Начало",
      "Приход",
      "Поступление от поставщика",
      "",
      "Расход",
      "Отчет о розничных продажах",
      "Продажа покупателю",
      "Конец",
      "",
      "",
      ""
    ],
    [
      "Номенклатура.Артикул",
      "Номенклатура.Найменування",
      "Кількість",
      "Кількість",
      "Кількість",
      "",
      "Кількість",
      "Кількість",
      "Кількість",
      "Кількість",
      "",
      "",
      ""
    ],
    [
      "Toppers 01 Lviv Gnatuka",
      "",
      10,
      3,
      3,
      13,
      4,
      4,
      "",
      9,
      3.25,
      58.5,
      0.31
    ],
    [
      "SO-FAST",
      "Быстрый товар",
      2,
      "",
      "",
      2,
      2,
      2,
      "",
      0,
      1,
      18,
      1
    ],
    [
      "SO-SLOW",
      "Медленный товар",
      6,
      "",
      "",
      6,
      1,
      1,
      "",
      5,
      6,
      108,
      0.16
    ],
    [
      "SX-ZERO-DAYS",
      "Продажа без розничного отчёта",
      1,
      "",
      "",
      1,
      1,
      "",
      1,
      0,
      "",
      "",
      0
    ],
    [
      "AA-FAST",
      "Не тот префикс",
      1,
      "",
      "",
      1,
      1,
      1,
      "",
      0,
      1,
      18,
      1
    ],
    [
      "PJ-FAST",
      "Быстрый PJ товар",
      4,
      "",
      "",
      4,
      2,
      2,
      "",
      1,
      2,
      36,
      0.5
    ]
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
  assert.match(answer, /Позиции: 2/);
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
  assert.match(answer, /Позиции: 2/);
  assert.match(answer, /Рекомендовано к заказу: 7/);
  assert.ok(fileMatch);
  assert.ok(fs.existsSync(fileMatch[1]));

  const workbook = await new ExcelJS.Workbook().xlsx.readFile(fileMatch[1]);
  const worksheet = workbook.getWorksheet("Замовлення");

  assert.equal(worksheet.getCell("A2").value, "SO-FAST");
  assert.equal(worksheet.getCell("A3").value, "PJ-FAST");
  assert.equal(worksheet.getCell("M2").value.result, 4);
  assert.match(worksheet.getCell("M2").value.formula, /ROUNDUP/);
  assert.equal(worksheet.getCell("M3").value.result, 3);

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
