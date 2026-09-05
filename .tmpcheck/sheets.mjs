import { manageSheets, formatSheetsResult } from "../src/tools/excel/sheets.js";
const memories = [
  "Excel файл загружен: data/telegram/999999/1700000001-staraya.xlsx",
  "Excel файл загружен: data/telegram/999999/1700000002-svezhaya.xlsx"
];
console.log("--- пути из памяти (как после загрузки в Telegram) ---");
console.log(formatSheetsResult(await manageSheets({ query: "покажи листы", memories, chatId: "999999" })));
console.log("\n--- без памяти, автопоиск по чату ---");
console.log(formatSheetsResult(await manageSheets({ query: "покажи листы", memories: [], chatId: "999999" })));
