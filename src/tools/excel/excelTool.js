import {
  existsInProject,
  extractSpreadsheetPaths,
  stripSpreadsheetPaths,
  loadWorkbooks
} from "./reader.js";
import { formatWorkbookAnalytics } from "./analytics.js";
import {
  formatPurchaseOrderResult,
  preparePurchaseOrder
} from "./inventory.js";
import {
  formatSalesOrderResult,
  hasSalesOrderReport,
  prepareSalesOrder
} from "./salesOrder.js";
import {
  analyzeDeadStock,
  formatDeadStockResult
} from "./deadStock.js";
import {
  filterRowsByName,
  formatFilterResult
} from "./filterByName.js";
import {
  buildTransferDoc,
  formatTransferResult,
  looksLikeTransferFile
} from "./transferDoc.js";
import {
  buildRedistribution,
  formatRedistributeResult
} from "./redistribute.js";
import {
  buildCriteriaTransfer,
  formatCriteriaTransferResult
} from "./transferByCriteria.js";
import {
  buildTransferFromText,
  buildTransferTemplate,
  formatTemplateResult,
  formatTextTransferResult,
  hasTransferText,
  isTemplateRequest
} from "./transferBuilder.js";
import {
  formatSheetsResult,
  hasSheetIntent,
  manageSheets
} from "./sheets.js";
import { searchRows } from "./search.js";
import { runEdit } from "./editor.js";
import { discoverChatFiles } from "./shared.js";

const HELP_TEXT = [
  "Excel-модуль. Всё, что делают кнопки, можно написать словами.",
  "Файл бот берёт последний присланный — или назови его в той же строке.",
  "",
  "📦 ЗАКАЗ ПОСТАВЩИКУ",
  "• заказ поставщику",
  "• замовлення Т1 18.06-5.07.xlsx — по конкретному файлу",
  "• заказ только презервативы и лубриканты — сузить до категорий",
  "• заказ поставщику весь товар — снять сужение",
  "Настройки дописываются в ту же строку:",
  "• продаж%=20 — минимальная реализация, по умолчанию 40%",
  "• days=90 — максимум дней запаса, по умолчанию 45",
  "• периодов=3 — на сколько периодов продаж закупаем, по умолчанию 2",
  "• период=30 — длина периода, если её не видно в имени файла",
  "• prefixes=PJ,SO — только артикулы с этими префиксами",
  "",
  "🎯 ПЕРЕНОС ПО УСЛОВИЮ",
  "• перенеси где реализация<20%",
  "• перенеси с Т1, Т7 и Т9 на Т10 где остаток>3",
  "• перенеси с Т1 на Т9 и Т10 кроме Т5 где запас>60",
  "• перенеси с Toppers 1 на ХОХО 2 где продаж<3",
  "Условия: реализация (%), продаж (шт), остаток (шт), запас (дней).",
  "Несколько сразу: «перенеси с Т1 где остаток>10 реализация<40%».",
  "Знаки: < > <= >= = или словами «меньше», «больше».",
  "",
  "♻️ РАЗВЕЗТИ ПО ПРОДАЖАМ — с магазина, где не продаётся, туда, где продаётся",
  "• развези по продажам",
  "• перемещение по нулевым продажам",
  "",
  "🔀 ПЕРЕМЕЩЕНИЕ",
  "• перемещение — разобрать книгу с листами-маршрутами («Т10 на Т1»)",
  "• шаблон перемещения с Т10 — пустая книга с листами по всей сети",
  "• Т10 на Т1: SO3206 12, PJ10440 2 — прямо сообщением, без Excel",
  "   несколько строк = несколько маршрутов; количество можно не писать",
  "",
  "🗂 НЕПРОДАННОЕ",
  "• непроданное — товары без розничных и оптовых продаж за период",
  "• что не продалось / неликвид — то же самое",
  "",
  "✂️ ФИЛЬТР, ПОИСК, АНАЛИТИКА",
  "• оставь только pjur — вырезать все строки, кроме нужных по названию",
  "• удали всё кроме презерватив — то же самое",
  "• найди PJ10050 в таблице — найти строки в книге",
  "   (просто «найди PJ10050» бот поймёт как поиск в интернете)",
  "• аналитика по excel-файлу — сводка по книге",
  "",
  "📑 ЛИСТЫ КНИГИ",
  "• покажи листы",
  "• создай лист Т9 / удали лист Т5 / переименуй лист Т5 в Т9",
  "• скопируй лист Т5 в Т9",
  "Исходный файл не меняется — бот присылает новую книгу.",
  "Книгу с картинками внутри бот покажет, но править не сможет: пересохрани её",
  "в Excel без картинок.",
  "",
  "✏️ ПРАВКА ЯЧЕЕК",
  "• поменяй артикул A123 на B456 в data/ostatki.xlsx",
  "",
  "ПРО ФАЙЛЫ",
  "Отчёты по разным точкам считаются вместе. Если одна точка есть в нескольких",
  "выгрузках, бот берёт самую свежую — иначе её продажи сложились бы дважды.",
  "Все команды работают и на кнопках: пришли файл и выбери действие."
].join("\n");

/**
 * Свой разбор входа: маршрутизатору нужны только запрос, память и чат —
 * files/outDir разбирает уже конкретный модуль-отчёт.
 * @param {unknown} input
 * @returns {{ query: string, memories: string[], chatId: string|null }}
 */
function normalizeInput(input) {
  if (typeof input === "string") {
    return {
      query: input,
      memories: [],
      chatId: null
    };
  }

  if (input && typeof input === "object") {
    const record = /** @type {Record<string, unknown>} */ (input);
    const rawQuery = record["query"];
    const rawMemories = record["memories"];
    const rawChatId = record["chatId"];

    return {
      query: typeof rawQuery === "string" ? rawQuery : String(rawQuery ?? ""),
      memories: Array.isArray(rawMemories)
        ? rawMemories.filter((value) => typeof value === "string")
        : [],
      chatId: rawChatId ? String(rawChatId) : null
    };
  }

  return {
    query: "",
    memories: [],
    chatId: null
  };
}

/**
 * @param {string} query
 * @returns {string}
 */
function removeExcelCommand(query) {
  return String(query || "")
    .replace(/^\/excel\b/i, "")
    .replace(/^\/purchase-order\b/i, "")
    .trim();
}

/**
 * @param {string} query
 * @param {string[]} memories
 * @param {string|null} [chatId]
 * @returns {string[]}
 */
function collectFilesForReadOnlyMode(query, memories, chatId = null) {
  const files = [
    ...new Set([
      ...extractSpreadsheetPaths(query),
      ...extractSpreadsheetPaths(memories.join("\n"))
    ])
  ].filter(existsInProject);

  return files.length > 0 ? files : discoverChatFiles(chatId);
}

/**
 * @param {import("./search.js").SearchMatch[]} matches
 * @returns {string}
 */
function formatSearchMatches(matches) {
  if (matches.length === 0) {
    return "В таблицах ничего не найдено.";
  }

  return [
    `Найдено строк: ${matches.length}`,
    "",
    ...matches.map((match, index) => {
      const cells = Object.entries(match.row)
        .filter(([, value]) => String(value).trim())
        .slice(0, 8)
        .map(([key, value]) => `${key}: ${value}`)
        .join("; ");

      return `${index + 1}. ${match.source.file}, ${match.source.sheet}, строка ${match.source.rowNumber}\n${cells}`;
    })
  ].join("\n");
}

/**
 * @param {string} query
 * @returns {string}
 */
function extractSearchQuery(query) {
  // \b здесь работать не может: в JS он определён только по латинице, и
  // после «найди» границы слова нет — глагол не срезался, а уезжал в
  // поисковую фразу. Бот честно искал в таблице текст «найди pj10050» и
  // ничего не находил, хотя латинское «search pj10050» работало.
  return stripSpreadsheetPaths(removeExcelCommand(query))
    .replace(
      /^(?:поиск|пошук|найди|найти|знайди|шукай|search|find)(?=[\s:,]|$)\s*/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} lower
 * @returns {boolean}
 */
function shouldPrepareSalesOrder(lower) {
  return (
    lower.includes("замовлення") ||
    lower.includes("заказ т1") ||
    lower.includes("заказ t1") ||
    lower.includes("замовлення т1") ||
    lower.includes("замовлення t1") ||
    lower.includes("заказ по отчету") ||
    lower.includes("заказ по отчёту") ||
    lower.includes("замовлення по звіту") ||
    lower.includes("отчет о розничных продажах") ||
    lower.includes("розничных продаж")
  );
}

/**
 * «Перенос по критериям»: «перенеси где реализация<20%». Отличается от
 * shouldRedistribute наличием явного условия со сравнением, поэтому проверяется
 * раньше. Знак «=» намеренно не считается условием: «замовлення реализация=40»
 * — это переопределение порога заказа, а не перенос.
 * @param {string} lower
 * @returns {boolean}
 */
function shouldMoveByCriteria(lower) {
  const hasCondition =
    /(?:реализац|реалізац|продаж|продал|остат|залиш|запас|дней|днів|sell)[\p{L}]*\s*(?:<=|>=|<|>|меньше|менее|менше|больше|более|більше)\s*\d/u
      .test(lower);
  const hasMoveVerb = /перенес|перенес[тьи]|вывез|вывоз|перекид/i.test(lower);

  return hasCondition && (hasMoveVerb || !/замовлення|заказ/i.test(lower));
}

/**
 * «Перемещение по нулевым продажам»: из отчётов продаж посчитать, что вывезти
 * со складов, где товар не продаётся, туда, где продаётся. Проверять ДО
 * shouldBuildTransfer — фраза «перемещение ... продаж 0» подходит обоим.
 * @param {string} lower
 * @returns {boolean}
 */
function shouldRedistribute(lower) {
  return (
    /перераспредел/i.test(lower) ||
    /развез|разброса|раскида/i.test(lower) ||
    (
      /перем[іие]щ|перекин|перенос/i.test(lower) &&
      /продаж|нулев|нол[ья]|непродающ|м[её]ртв|неликвид|\b0\b/i.test(lower)
    )
  );
}

/**
 * «Документ перемещения»: список артикулов по листам-магазинам → плоская
 * таблица «Со склада / На склад / Артикул / Название / Кол-во / Примечание».
 * @param {string} lower
 * @returns {boolean}
 */
function shouldBuildTransfer(lower) {
  return (
    /перем[іие]щ/i.test(lower) ||
    /перекин/i.test(lower) ||
    lower.includes("документ перемещения")
  );
}

/**
 * «Оставь только <текст>» / «удали всё кроме <текст>»: вырезать из файла все
 * строки, кроме тех, где в названии есть заданная подстрока.
 * @param {string} lower
 * @returns {boolean}
 */
function shouldFilterByName(lower) {
  // Без \b после кириллицы: в JS \b работает только по ASCII-словам.
  return (
    /остав(?:ь|ить|и)\s+(?:тольк[ои]|лишь)/i.test(lower) ||
    /удали(?:ть)?\s+(?:вс[её]|все)\s+кроме/i.test(lower) ||
    /залиши(?:ти)?\s+тільки/i.test(lower) ||
    /видали(?:ти)?\s+вс[еі]\s+кр[іи]м/i.test(lower) ||
    /keep\s+only/i.test(lower)
  );
}

/**
 * «Непроданное» / неликвид: собрать товары без розничных и оптовых продаж
 * за период из нескольких файлов в один Excel.
 * @param {string} lower
 * @returns {boolean}
 */
function shouldReportDeadStock(lower) {
  return (
    /непродан|не\s+продал|нераспродан|неликвид|залежал|мертв\w*\s+товар|dead\s*stock/i
      .test(lower) ||
    lower.includes("что не продалось") ||
    lower.includes("не продавалось")
  );
}

/**
 * @param {string} lower
 * @returns {boolean}
 */
function shouldEditExcel(lower) {
  return (
    /измени|поменяй|исправь|обнови|замени/i.test(lower) &&
    /артикул|excel|csv|таблиц|файл|ячейк|штрихкод|sku/i.test(lower)
  );
}

/**
 * @param {string} query
 * @param {string[]} memories
 * @returns {boolean}
 */
function hasExplicitPurchaseOrderFiles(query, memories) {
  return /(?:остатк|stock|inventory|прайс|price|supplier|поставщик)\s*[:=]/i
    .test(`${query}\n${memories.join("\n")}`);
}

/**
 * @param {unknown} input
 * @returns {Promise<string>}
 */
export async function runExcelTool(input) {
  const request = normalizeInput(input);
  const query = removeExcelCommand(request.query);
  const lower = query.toLowerCase();

  if (!query || lower === "help" || lower === "помощь") {
    return HELP_TEXT;
  }

  // Листы проверяем раньше правки ячеек: «удали лист Т5» — про структуру
  // книги, а не про её содержимое.
  if (hasSheetIntent(query)) {
    const result = await manageSheets({
      query,
      memories: request.memories,
      chatId: request.chatId
    });

    return formatSheetsResult(result);
  }

  if (shouldEditExcel(lower)) {
    return await runEdit({
      query,
      memories: request.memories,
      chatId: request.chatId
    });
  }

  if (shouldMoveByCriteria(lower)) {
    const result = await buildCriteriaTransfer({
      query,
      memories: request.memories,
      chatId: request.chatId
    });

    return formatCriteriaTransferResult(result);
  }

  if (shouldRedistribute(lower)) {
    const result = await buildRedistribution({
      query,
      memories: request.memories,
      chatId: request.chatId
    });

    return formatRedistributeResult(result);
  }

  // Шаблон и текстовое перемещение проверяются РАНЬШЕ разбора книги:
  // «шаблон перемещения с Т10» содержит слово «перемещение», а строка
  // «Т10 на Т1: SO3206 12» вообще не обязана его содержать.
  if (isTemplateRequest(query)) {
    const result = await buildTransferTemplate({
      query,
      memories: request.memories,
      chatId: request.chatId
    });

    return formatTemplateResult(result);
  }

  if (hasTransferText(query)) {
    const result = await buildTransferFromText({
      query,
      memories: request.memories,
      chatId: request.chatId
    });

    return formatTextTransferResult(result);
  }

  if (shouldBuildTransfer(lower)) {
    const result = await buildTransferDoc({
      query,
      memories: request.memories,
      chatId: request.chatId
    });

    return formatTransferResult(result);
  }

  if (shouldFilterByName(lower)) {
    const result = await filterRowsByName({
      query,
      memories: request.memories,
      chatId: request.chatId
    });

    return formatFilterResult(result);
  }

  if (shouldReportDeadStock(lower)) {
    const result = await analyzeDeadStock({
      query,
      memories: request.memories,
      chatId: request.chatId
    });

    return formatDeadStockResult(result);
  }

  if (shouldPrepareSalesOrder(lower)) {
    const result = await prepareSalesOrder({
      query,
      memories: request.memories,
      chatId: request.chatId
    });

    return formatSalesOrderResult(result);
  }

  if (
    lower.includes("аналит") ||
    lower.includes("отчет") ||
    lower.includes("отчёт") ||
    lower.includes("summary")
  ) {
    const files = collectFilesForReadOnlyMode(
      query,
      request.memories,
      request.chatId
    );

    if (files.length === 0) {
      return "Не нашёл Excel/CSV-файлы для аналитики. Укажи путь к файлу или положи таблицы в data/.";
    }

    return formatWorkbookAnalytics(loadWorkbooks(files));
  }

  if (
    lower.startsWith("поиск") ||
    lower.startsWith("найди") ||
    lower.startsWith("найти") ||
    lower.startsWith("search")
  ) {
    const files = collectFilesForReadOnlyMode(
      query,
      request.memories,
      request.chatId
    );
    const searchQuery = extractSearchQuery(query);

    if (!searchQuery) {
      return "Напиши, что искать в таблицах. Например: /excel поиск шампунь data/ostatki.xlsx";
    }

    if (files.length === 0) {
      return "Не нашёл Excel/CSV-файлы для поиска. Укажи путь к файлу или положи таблицы в data/.";
    }

    return formatSearchMatches(
      searchRows(loadWorkbooks(files), searchQuery)
    );
  }

  if (
    !hasExplicitPurchaseOrderFiles(query, request.memories) &&
    hasSalesOrderReport({
      query,
      memories: request.memories,
      chatId: request.chatId
    })
  ) {
    const result = await prepareSalesOrder({
      query,
      memories: request.memories,
      chatId: request.chatId
    });

    return formatSalesOrderResult(result);
  }

  const result = await preparePurchaseOrder({
    query,
    memories: request.memories,
    chatId: request.chatId
  });

  // Под "заказ поставщику" подсунули список перемещения: колонки остатка в нём
  // нет и не будет. Вместо тупикового отказа собираем то, чем файл является.
  if (result.reason === "not_stock_file") {
    const transferFiles = result.stockFiles.filter(looksLikeTransferFile);

    if (transferFiles.length > 0) {
      const transfer = await buildTransferDoc({
        query,
        memories: request.memories,
        chatId: request.chatId,
        files: transferFiles
      });

      if (transfer.status === "success") {
        return [
          "Это список перемещения, а не остатки — заказ поставщику по нему не собрать.",
          "Собрал документ перемещения:",
          "",
          formatTransferResult(transfer)
        ].join("\n");
      }
    }
  }

  return formatPurchaseOrderResult(result);
}

export default {
  run: runExcelTool
};