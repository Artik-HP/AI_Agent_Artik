import fs from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";

const OUTPUT_DIR = "exports";

/**
 * @param {Date} [date]
 * @returns {string}
 */
function createTimestamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
}

/**
 * @param {ExcelJS.Worksheet} worksheet
 * @returns {void}
 */
function styleHeader(worksheet) {
  const headerRow = worksheet.getRow(1);

  headerRow.font = {
    bold: true,
    color: {
      argb: "FFFFFFFF"
    }
  };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: {
      argb: "FF1F4E79"
    }
  };
  headerRow.alignment = {
    vertical: "middle",
    wrapText: true
  };
}

/**
 * @param {ExcelJS.Worksheet} worksheet
 * @returns {void}
 */
function applyTableStyle(worksheet) {
  styleHeader(worksheet);
  worksheet.views = [
    {
      state: "frozen",
      ySplit: 1
    }
  ];
  worksheet.autoFilter = {
    from: "A1",
    to: `${worksheet.getColumn(worksheet.columnCount).letter}1`
  };

  worksheet.eachRow(row => {
    row.eachCell(cell => {
      cell.border = {
        bottom: {
          style: "thin",
          color: {
            argb: "FFE5E7EB"
          }
        }
      };
      cell.alignment = {
        vertical: "top",
        wrapText: true
      };
    });
  });
}

/**
 * @param {number|null|undefined} value
 * @returns {number|string}
 */
function valueOrEmpty(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : "";
}

/**
 * @param {import("./inventory.js").PurchaseOrderResult} result
 * @param {{ outputDir?: string }} [options]
 * @returns {Promise<string>}
 */
export async function writePurchaseOrderWorkbook(result, options = {}) {
  const outputDir = path.resolve(process.cwd(), options.outputDir || OUTPUT_DIR);
  const filePath = path.join(
    outputDir,
    `purchase-order-${createTimestamp()}.xlsx`
  );

  fs.mkdirSync(outputDir, {
    recursive: true
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AI_Agent_Artik";
  workbook.created = new Date();

  const orderSheet = workbook.addWorksheet("Заказ");
  orderSheet.columns = [
    { header: "Артикул", key: "sku", width: 18 },
    { header: "Штрихкод", key: "barcode", width: 18 },
    { header: "Товар", key: "product", width: 36 },
    { header: "Остаток", key: "currentStock", width: 12 },
    { header: "Мин. остаток", key: "minStock", width: 14 },
    { header: "Заказать", key: "orderQuantity", width: 12 },
    { header: "Поставщик", key: "supplier", width: 24 },
    { header: "Цена", key: "price", width: 12 },
    { header: "Сумма", key: "total", width: 14 },
    { header: "Источник", key: "source", width: 30 }
  ];

  for (const line of result.lines) {
    orderSheet.addRow({
      sku: line.sku,
      barcode: line.barcode,
      product: line.product,
      currentStock: line.currentStock,
      minStock: line.minStock,
      orderQuantity: line.orderQuantity,
      supplier: line.supplier,
      price: valueOrEmpty(line.price),
      total: valueOrEmpty(line.total),
      source: line.source
    });
  }

  orderSheet.getColumn("price").numFmt = "#,##0.00";
  orderSheet.getColumn("total").numFmt = "#,##0.00";
  applyTableStyle(orderSheet);

  const summarySheet = workbook.addWorksheet("Сводка");
  summarySheet.columns = [
    { header: "Показатель", key: "metric", width: 32 },
    { header: "Значение", key: "value", width: 50 }
  ];
  summarySheet.addRows([
    {
      metric: "Позиции к заказу",
      value: result.summary.lines
    },
    {
      metric: "Позиции без цены",
      value: result.summary.missingPrice
    },
    {
      metric: "Предварительная сумма",
      value: result.summary.estimatedTotal
    },
    {
      metric: "Файлы остатков",
      value: result.stockFiles.join(", ")
    },
    {
      metric: "Прайсы поставщиков",
      value: result.priceFiles.join(", ") || "не указаны"
    }
  ]);
  summarySheet.getColumn("value").numFmt = "#,##0.00";
  applyTableStyle(summarySheet);

  const missingLines = result.lines.filter(line => line.price === null);

  if (missingLines.length > 0) {
    const missingSheet = workbook.addWorksheet("Без цены");
    missingSheet.columns = [
      { header: "Артикул", key: "sku", width: 18 },
      { header: "Штрихкод", key: "barcode", width: 18 },
      { header: "Товар", key: "product", width: 36 },
      { header: "Заказать", key: "orderQuantity", width: 12 },
      { header: "Источник", key: "source", width: 30 }
    ];
    missingSheet.addRows(missingLines.map(line => ({
      sku: line.sku,
      barcode: line.barcode,
      product: line.product,
      orderQuantity: line.orderQuantity,
      source: line.source
    })));
    applyTableStyle(missingSheet);
  }

  await workbook.xlsx.writeFile(filePath);

  return filePath;
}

export async function createReport(result, options = {}) {
  return await writePurchaseOrderWorkbook(result, options);
}

