import fs from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";

import { MOVEMENT_LABELS } from "./columns.js";
import {
  createTimestamp,
  discoverChatFiles,
  keepFreshestPointRecords,
  looksLikeGeneratedReport,
  OUTPUT_DIR
} from "./shared.js";
import {
  existsInProject,
  extractSpreadsheetPaths,
  normalizeHeader,
  readSheetMatrices,
  resolveProjectPath,
  selectReportSheets,
  sheetPointName,
  toProjectPath
} from "./reader.js";
import { parseNumber } from "./search.js";
import { loadSupplySettings } from "./reportGenerator.js";
import {
  classifyOrderCategory,
  mentionsOrderCategory,
  orderCategoryTitles
} from "./categories.js";
import {
  isSectionHeader,
  normalizeSkuKey,
  readReportFile
} from "./deadStock.js";
import {
  buildPointMetrics,
  planTransfers,
  resolvePeriod,
  resolveTransferSettings
} from "./transferByCriteria.js";
import { rememberPointName } from "./points.js";

const DEFAULT_MAX_STOCK_DAYS = 45;
const DEFAULT_TARGET_PERIODS = 2;

/**
 * Префиксы артикулов = БРЕНДЫ (pjur, System JO, Noir Handmade), а не категории,
 * поэтому фильтром заказа они больше не работают: презервативы и лубриканты
 * рассыпаны по всем префиксам и по «голым» цифровым артикулам. Осталось два
 * применения: порядок сортировки строк в готовом файле и явное сужение из
 * запроса («замовлення prefixes=SO,PR»). Значение по умолчанию — из config.yaml
 * (supply_settings.sku_prefixes); этот массив используется, если конфиг
 * недоступен.
 */
const DEFAULT_SKU_PREFIXES = [
  "PJ",
  "SX",
  "SO",
  "FM",
  "AD",
  "MD",
  "AL"
];

/** Порог реализации по умолчанию, если не задан в config.yaml и не в запросе. */
const FALLBACK_MIN_SELL_THROUGH = 0.4;

/**
 * Позиции колонок в «эталонной» выгрузке. Используются как запасной вариант,
 * если колонку не удалось найти по тексту заголовка.
 */
const LEGACY_COLUMN_INDEX = {
  sku: 0,
  name: 1,
  start: 2,
  receipt: 3,
  expense: 6,
  retailSales: 7,
  buyerSales: 8,
  end: 9
};

/** Ширина периода отчёта по умолчанию, если не задана и не вычислена из дат. */
const FALLBACK_PERIOD_DAYS = 14;

/**
 * Тексты заголовков, по которым ищем нужные колонки в первых строках отчёта.
 * Раскладка выгрузок из 1С/BAS отличается между торговыми точками, поэтому
 * позицию колонки определяем по названию, а не по индексу.
 */
const HEADER_LABELS = MOVEMENT_LABELS;

const FILL_COLORS = {
  available: "FFBDD7EE",
  retailSales: "FFC5E0B4",
  end: "FFD9D9D9",
  order: "FFFBE5D6"
};

/**
 * @typedef {Object} SalesOrderLine
 * @property {number} sourceRow
 * @property {string} [point] точка (имя вкладки), "" если вкладка одна
 * @property {string} sku
 * @property {string} name
 * @property {string} category закупаемая категория: «Презервативи», «Лубриканти»
 *   или "" — товар не из закупаемых категорий
 * @property {number|null} start
 * @property {number|null} receipt
 * @property {number|null} available
 * @property {number|null} expense
 * @property {number|null} retailSales
 * @property {number|null} buyerSales
 * @property {number|null} end
 * @property {number|null} turnover
 * @property {number|null} stockDays
 * @property {number|null} sellThrough
 * @property {number} recommendedOrder
 */

/**
 * @typedef {Object} SalesOrderOptions
 * @property {number} maxStockDays
 * @property {number} targetPeriods
 * @property {string[]} skuPrefixes порядок сортировки строк, не фильтр
 * @property {string[]|null} prefixFilter сужение из запроса «prefixes=SO,PR»
 * @property {string[]} categories названия закупаемых категорий
 * @property {boolean} categoriesOnly сузить ли заказ до этих категорий
 * @property {number} periodDays
 * @property {number} minSellThrough доля Расход/(Начало+Приход), ниже которой не заказываем
 */

/**
 * @typedef {Object} SalesOrderStats
 * @property {number} productRows строк с артикулом и наименованием
 * @property {number} categoryMatched прошло фильтр категорий (== productRows,
 *   когда сужения не просили)
 * @property {number} prefixMatched из них с нужным префиксом артикула
 * @property {number} withSales из них с расходом больше нуля
 * @property {number} lowSellThrough отброшено: реализация ниже порога minSellThrough
 * @property {number} overstocked отброшено как затоваренные (запас больше лимита)
 */

/**
 * @typedef {Object} SalesOrderResult
 * @property {"success"|"needs_file"|"empty"} status
 * @property {string|null} sourceFile
 * @property {string|null} outputPath
 * @property {SalesOrderOptions} options
 * @property {SalesOrderLine[]} lines
 * @property {{ lines: Object[], stats: Object, error?: string }} [transfer] лист «Переміщення»
 * @property {{ lines: number, recommendedTotal: number }} summary
 * @property {SalesOrderStats} [stats]
 * @property {string[]} notes
 */

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
  return [...new Set(values.map(value => String(value || "").trim()))]
    .filter(Boolean);
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
  return parseNumber(value);
}

/**
 * @param {unknown} value
 * @returns {number|string}
 */
function valueOrEmpty(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : "";
}

/**
 * @param {string} query
 * @returns {number}
 */
function extractMaxStockDays(query) {
  const match = query.match(
    /(?:days|max_days|дней|дн(?:ів|ей)?|дни|днів)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i
  );

  return match
    ? toNumber(match[1]) || DEFAULT_MAX_STOCK_DAYS
    : DEFAULT_MAX_STOCK_DAYS;
}

/**
 * @param {string} query
 * @returns {number}
 */
function extractTargetPeriods(query) {
  const match = query.match(
    /(?:periods?|target|коэф|коеф|множитель|период(?:ов|а)?)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i
  );

  return match
    ? toNumber(match[1]) || DEFAULT_TARGET_PERIODS
    : DEFAULT_TARGET_PERIODS;
}

/**
 * Список префиксов из config.yaml (supply_settings.sku_prefixes). Строку
 * «PJ, SX» тоже принимаем. Если ничего валидного нет — DEFAULT_SKU_PREFIXES.
 * @returns {string[]}
 */
function configuredSkuPrefixes() {
  const raw = loadSupplySettings().sku_prefixes;
  const list = (Array.isArray(raw) ? raw : String(raw || "").split(/[\s,]+/))
    .map(prefix => String(prefix).trim().toUpperCase())
    .filter(Boolean);

  return list.length > 0 ? list : DEFAULT_SKU_PREFIXES;
}

/**
 * Префиксы, названные в запросе явно: «замовлення prefixes=SO,PR». Только они
 * сужают заказ — сам по себе префикс категорию не задаёт.
 * @param {string} query
 * @returns {string[]|null} null — сужения не просили
 */
function extractSkuPrefixes(query) {
  const match = query.match(
    /(?:prefixes?|префиксы|префикс)\s*[:=]\s*([a-zа-я0-9,\s]+)/i
  );

  if (!match) {
    return null;
  }

  const prefixes = match[1]
    .split(/[\s,]+/)
    .map(prefix => prefix.trim().toUpperCase())
    .filter(Boolean);

  return prefixes.length > 0 ? prefixes : null;
}

/**
 * Ограничить ли заказ закупаемыми категориями (презервативы, лубриканты).
 * По умолчанию заказ собирается по ЛЮБОМУ товару — сужение включается только
 * по просьбе: «заказ только презервативы и лубриканты», кнопка в Telegram или
 * `supply_settings.order_categories_only: true` в config.yaml.
 *
 * Признак включения — название категории в запросе, а не слово «только»:
 * «оставь только pjur» — это совсем другая команда, и слово там то же самое.
 * @param {string} query
 * @returns {boolean}
 */
function extractCategoriesOnly(query) {
  const text = String(query || "");

  // Явное «весь товар» перебивает и настройку из конфига.
  if (/(?:вс[её]|весь|люб(?:ой|ые)|будь-як\p{L}*|any|all)\s+товар/iu.test(text)) {
    return false;
  }

  if (mentionsOrderCategory(text)) {
    return true;
  }

  return Boolean(loadSupplySettings().order_categories_only);
}

/**
 * Минимальная реализация (Расход / (Начало + Приход)), ниже которой позиция
 * в заказ не идёт. Понимает «продаж%=40», «реализация=0.4», «sell_through=40».
 * Значение больше 1 трактуется как проценты. Иначе — из config.yaml.
 * @param {string} query
 * @returns {number}
 */
function extractMinSellThrough(query) {
  const fallback = Number(loadSupplySettings().min_sell_through);
  const base = Number.isFinite(fallback) && fallback >= 0 && fallback < 1
    ? fallback
    : FALLBACK_MIN_SELL_THROUGH;
  const match = String(query || "").match(
    /(?:sell[_\s-]?through|min[_\s-]?sell|продаж\s*%|%\s*продаж|реализаци[яи]|процент\s+продаж)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i
  );

  if (!match) {
    return base;
  }

  const value = toNumber(match[1]) || 0;
  const ratio = value > 1 ? value / 100 : value;

  return ratio >= 0 && ratio < 1 ? ratio : base;
}

/**
 * Длина периода отчёта в днях. Разбор общий с переносом по критериям: он
 * понимает и «18.06-5.07.2026» в имени файла, и словесное «за 1 рік» —
 * годовую выгрузку, принятую за 18 дней, заказ раздувал в двадцать раз.
 *
 * «период=N» из запроса читаем сами и раньше всего: общий разбор считает
 * периодом ещё и «days=N», а в замовленні это лимит запаса, а не период.
 * @param {string} query
 * @param {string} sourceHint путь/имя файла-отчёта
 * @returns {number}
 */
function extractPeriodDays(query, sourceHint = "") {
  const explicit = String(query || "").match(
    /(?:период|перiод|період)\s*[:=]?\s*(\d{1,4})/i
  );

  if (explicit) {
    const days = Number(explicit[1]);

    if (days >= 1 && days <= 1500) {
      return days;
    }
  }

  const resolved = resolvePeriod(sourceHint ? [sourceHint] : []).days;

  return resolved || loadSupplySettings().default_period_days || FALLBACK_PERIOD_DAYS;
}

/**
 * @param {string} query
 * @param {string} [sourceHint] имя файла-отчёта — там тоже бывают даты периода
 * @returns {SalesOrderOptions}
 */
function parseOptions(query, sourceHint = "") {
  const prefixFilter = extractSkuPrefixes(query);

  return {
    maxStockDays: extractMaxStockDays(query),
    targetPeriods: extractTargetPeriods(query),
    // Порядок строк в файле: если префиксы названы в запросе — их порядок,
    // иначе привычный из config.yaml.
    skuPrefixes: prefixFilter || configuredSkuPrefixes(),
    prefixFilter,
    categories: orderCategoryTitles(),
    categoriesOnly: extractCategoriesOnly(query),
    periodDays: extractPeriodDays(query, sourceHint),
    minSellThrough: extractMinSellThrough(query)
  };
}

/**
 * Находит индексы колонок отчёта по тексту заголовков в первых строках.
 * Колонки, которые не удалось распознать, берутся из LEGACY_COLUMN_INDEX.
 * @param {unknown[][]} rows
 * @returns {Record<string, number>}
 */
function resolveColumns(rows) {
  const headerRows = rows.slice(0, 5);
  /** @type {Record<string, number>} */
  const resolved = {
    sku: LEGACY_COLUMN_INDEX.sku,
    name: LEGACY_COLUMN_INDEX.name
  };

  for (const [key, labels] of Object.entries(HEADER_LABELS)) {
    const normalizedLabels = labels.map(normalizeHeader);
    let found = -1;

    for (const row of headerRows) {
      found = (Array.isArray(row) ? row : []).findIndex(cell => {
        const header = normalizeHeader(cell);

        return (
          header.length >= 4 &&
          normalizedLabels.some(label =>
            header === label || header.includes(label) || label.includes(header)
          )
        );
      });

      if (found !== -1) {
        break;
      }
    }

    resolved[key] = found === -1 ? LEGACY_COLUMN_INDEX[key] : found;
  }

  return resolved;
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isLikelyMovementReport(filePath) {
  try {
    // Достаточно одной подходящей вкладки: первая бывает титульной или сводной,
    // а сам отчёт лежит на второй.
    return readSheetMatrices(filePath).some(sheet => {
      const headerText = sheet.rows
        .slice(0, 3)
        .flat()
        .join(" ")
        .toLowerCase();

      return (
        headerText.includes("отчет о розничных продажах") ||
        headerText.includes("звіт") ||
        headerText.includes("розничных продаж")
      );
    });
  } catch {
    return false;
  }
}

/**
 * @param {string} query
 * @param {string[]} memories
 * @param {string|null} [chatId]
 * @returns {string|null}
 */
function findReportFile(query, memories, chatId = null) {
  // Явно названный в запросе файл — приоритетнее. Дальше идут пути из памяти,
  // но в обратном порядке: последний загруженный в Telegram отчёт — первым.
  const queryFiles = extractSpreadsheetPaths(query);
  const memoryFiles = extractSpreadsheetPaths(memories.join("\n")).reverse();
  const files = unique([...queryFiles, ...memoryFiles]).filter(existsInProject);

  if (files.length > 0) {
    return files.find(file => !looksLikeGeneratedReport(file)) || files[0];
  }

  const discovered = discoverChatFiles(chatId)
    .filter(file => !looksLikeGeneratedReport(file));

  return discovered.find(isLikelyMovementReport) || discovered[0] || null;
}

/** Сколько выгрузок максимум берём в расчёт перемещения. */
const MAX_TRANSFER_FILES = 12;

/**
 * Отчёты, по которым строится лист «Переміщення». Заказ считается по одному
 * файлу — тому, что назвали; перемещение без второго магазина не существует,
 * поэтому здесь берём все отчёты движения, что есть в чате: свежие первыми.
 * @param {string} query
 * @param {string[]} memories
 * @param {string|null} [chatId]
 * @param {string|null} [primary] отчёт заказа — он в списке всегда и первым
 * @returns {string[]}
 */
function findTransferFiles(query, memories, chatId = null, primary = null) {
  const queryFiles = extractSpreadsheetPaths(query);
  const memoryFiles = extractSpreadsheetPaths(memories.join("\n")).reverse();
  const named = unique([
    ...(primary ? [primary] : []),
    ...queryFiles,
    ...memoryFiles
  ]).filter(file => existsInProject(file) && !looksLikeGeneratedReport(file));
  // Магазин назвали один — сам по себе он никуда не переезжает, поэтому
  // добираем остальные выгрузки чата. Назвали несколько — считаем ровно по
  // ним: раз перечислили руками, значит так и хотели.
  const candidates = named.length > 1
    ? named
    : unique([...named, ...discoverChatFiles(chatId)])
      .filter(file => !looksLikeGeneratedReport(file));

  return candidates
    .slice(0, MAX_TRANSFER_FILES)
    .filter(file => file === primary || isLikelyMovementReport(file));
}

/**
 * @param {unknown} input
 * @returns {boolean}
 */
export function hasSalesOrderReport(input) {
  const request = normalizeInput(input);
  // chatId обязателен: без него findReportFile не смотрит в загрузки чата, и
  // «заказ поставщику» с пустой памятью уходил в ветку остатки+прайс с ответом
  // «Это не похоже на файл остатков» — при том, что нужный отчёт лежал в пуле.
  const sourceFile = findReportFile(
    request.query,
    request.memories,
    request.chatId
  );

  return Boolean(sourceFile && isLikelyMovementReport(sourceFile));
}

/**
 * Строка товара: есть артикул и наименование. Строки-заголовки складов
 * (в первой колонке — название точки, вторая пустая) и служебные строки
 * отсекаются.
 * @param {unknown[]} row
 * @param {Record<string, number>} columns
 * @returns {boolean}
 */
function isProductRow(row, columns) {
  const sku = String(row[columns.sku] || "").trim();
  const name = String(row[columns.name] || "").trim();

  return Boolean(
    sku &&
    name &&
    sku !== "Номенклатура.Артикул" &&
    !/^номенклатура\b/i.test(sku)
  );
}

/**
 * @param {string} sku
 * @param {string[]} prefixes
 * @returns {number}
 */
function getPrefixRank(sku, prefixes) {
  const normalizedSku = sku.toUpperCase();
  const rank = prefixes.findIndex(prefix =>
    normalizedSku.startsWith(prefix)
  );

  return rank === -1 ? prefixes.length : rank;
}

/**
 * @param {string} sku
 * @param {string[]} prefixes
 * @returns {boolean}
 */
function hasAllowedPrefix(sku, prefixes) {
  const normalizedSku = sku.toUpperCase();

  return prefixes.some(prefix =>
    normalizedSku.startsWith(prefix)
  );
}

/**
 * Сколько единиц заказать поставщику по одной строке отчёта. Держи расчёт
 * согласованным с buildOrderFormula (колонка «Заказ» в готовом Excel): если
 * меняешь модель здесь — поправь и формулу, иначе кэшированный итог и живой
 * пересчёт в файле разойдутся.
 * @param {{ expense: number, available: number, end: number, retailSales: number|null, buyerSales: number|null, turnover: number, stockDays: number, sellThrough: number }} metrics
 * @param {SalesOrderOptions} options
 * @returns {number} целое >= 0; 0 = заказывать не нужно
 */
function computeRecommendedOrder(metrics, options) {
  const { expense, end } = metrics;

  // Держим запас на options.targetPeriods периодов продаж и вычитаем остаток.
  // Ровно эта же арифметика продублирована в buildOrderFormula как живая
  // Excel-формула колонки «Заказ» — меняешь модель, меняй оба места.
  const recommendedOrder = Math.max(
    0,
    Math.ceil(expense * options.targetPeriods - end)
  );

  return Math.max(0, Math.trunc(Number(recommendedOrder) || 0));
}

/**
 * Разбирает строку отчёта и объясняет, на каком шаге фильтра она отсеялась.
 * @param {unknown[]} row
 * @param {number} sourceRow
 * @param {SalesOrderOptions} options
 * @param {Record<string, number>} columns
 * @returns {{ stage: "not_product"|"wrong_prefix"|"no_sales"|"low_sellthrough"|"overstocked"|"ok", line: SalesOrderLine|null }}
 */
function classifyReportRow(row, sourceRow, options, columns) {
  if (!isProductRow(row, columns)) {
    return { stage: "not_product", line: null };
  }

  const sku = String(row[columns.sku]).trim();
  const name = String(row[columns.name] || "").trim();
  // Категория считается всегда — она попадает в колонку «Категорія» и в
  // сортировку. Отсекает она только тогда, когда об этом попросили: заказ по
  // умолчанию собирается по любому товару.
  const category = classifyOrderCategory(name);

  if (options.categoriesOnly && !category) {
    return { stage: "wrong_category", line: null };
  }

  if (options.prefixFilter && !hasAllowedPrefix(sku, options.prefixFilter)) {
    return { stage: "wrong_prefix", line: null };
  }

  const start = toNumber(row[columns.start]);
  const receipt = toNumber(row[columns.receipt]);
  const expense = toNumber(row[columns.expense]) || 0;
  const end = toNumber(row[columns.end]) || 0;
  const available = (start || 0) + (receipt || 0);

  if (expense <= 0) {
    return { stage: "no_sales", line: null };
  }

  // turnover — на сколько «периодов» продаж хватает поступивших единиц.
  // stockDays — то же в днях. sellThrough — доля проданного из поступившего.
  const turnover = available > 0 ? available / expense : 0;
  const stockDays = turnover * options.periodDays;
  const sellThrough = available > 0 ? expense / available : 0;

  // Правило закупщика: продали меньше порога от того, что было в наличии, —
  // товар не движется, новый завоз не нужен.
  if (available > 0 && sellThrough < options.minSellThrough) {
    return { stage: "low_sellthrough", line: null };
  }

  if (stockDays > options.maxStockDays) {
    return { stage: "overstocked", line: null };
  }

  const retailSales = toNumber(row[columns.retailSales]);
  const buyerSales = toNumber(row[columns.buyerSales]);
  const recommendedOrder = computeRecommendedOrder(
    { expense, available, end, retailSales, buyerSales, turnover, stockDays, sellThrough },
    options
  );

  return {
    stage: "ok",
    line: {
      sourceRow,
      sku,
      name,
      category: category || "",
      start,
      receipt,
      available,
      expense,
      retailSales,
      buyerSales,
      end,
      turnover: Number(turnover.toFixed(3)),
      stockDays: Number(stockDays.toFixed(1)),
      sellThrough: Number(sellThrough.toFixed(3)),
      recommendedOrder
    }
  };
}

/**
 * Разбирает одну вкладку: раскладка колонок определяется внутри вкладки, у
 * разных точек она разная.
 * @param {import("./reader.js").SheetMatrix} sheet
 * @param {SalesOrderOptions} options
 * @param {string} sheetPoint название точки по имени вкладки, "" для книги из
 *   одного листа; строка-склад внутри листа его перебивает
 * @returns {{ lines: SalesOrderLine[], stats: SalesOrderStats }}
 */
function readReportSheet(sheet, options, sheetPoint) {
  const rows = sheet.rows;
  const columns = resolveColumns(rows);
  const stats = {
    productRows: 0,
    categoryMatched: 0,
    prefixMatched: 0,
    withSales: 0,
    lowSellThrough: 0,
    overstocked: 0
  };
  /** @type {SalesOrderLine[]} */
  const lines = [];
  // Выгрузка «все магазины» кладёт все точки на один лист и разделяет их
  // строками-складами. Без этого один и тот же презерватив попадал в заказ
  // четырнадцать раз подряд, и было не понять, какому магазину он нужен.
  let point = sheetPoint;

  rows.forEach((row, index) => {
    if (isSectionHeader(row)) {
      point = String(row[0]).trim();
      rememberPointName(point);

      return;
    }

    const { stage, line } = classifyReportRow(row, index + 1, options, columns);

    if (stage === "not_product") {
      return;
    }

    stats.productRows += 1;

    if (stage === "wrong_category") {
      return;
    }

    stats.categoryMatched += 1;

    if (stage === "wrong_prefix") {
      return;
    }

    stats.prefixMatched += 1;

    if (stage === "no_sales") {
      return;
    }

    stats.withSales += 1;

    if (stage === "low_sellthrough") {
      stats.lowSellThrough += 1;
      return;
    }

    if (stage === "overstocked") {
      stats.overstocked += 1;
      return;
    }

    if (line) {
      lines.push({ ...line, point });
    }
  });

  return { lines, stats };
}

/**
 * Один и тот же артикул на нескольких точках — это один товар в разных
 * магазинах. Поставщику уходит одна поставка, поэтому строки одного артикула
 * с разных точек склеиваются в одну: суммируемые величины (остатки, приход,
 * расход, продажи) складываются, а turnover/stockDays/sellThrough и заказ
 * пересчитываются заново по сумме — усреднять готовые проценты между точками
 * нельзя, это даёт другое число, чем «сколько всего продали от того, что было».
 * `point` сохраняет все точки через запятую — это единственное место, где
 * видно, что строка объединённая.
 * @param {SalesOrderLine[]} lines
 * @param {SalesOrderOptions} options
 * @returns {SalesOrderLine[]}
 */
function combineSheetLines(lines, options) {
  /** @type {Map<string, SalesOrderLine[]>} */
  const groups = new Map();

  for (const line of lines) {
    const key = line.sku.trim().toUpperCase();

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(line);
  }

  return [...groups.values()].map(group => {
    if (group.length === 1) {
      return group[0];
    }

    const sum = field =>
      group.reduce((total, line) => total + (line[field] || 0), 0);
    // Продажи бывают null, когда колонки в отчёте нет вовсе — тогда и сумма
    // должна остаться null, а не притвориться нулевыми продажами.
    const sumOrNull = field =>
      group.some(line => line[field] !== null) ? sum(field) : null;

    const start = sum("start");
    const receipt = sum("receipt");
    const expense = sum("expense");
    const end = sum("end");
    const available = start + receipt;
    const turnover = available > 0 ? available / expense : 0;
    const stockDays = turnover * options.periodDays;
    const sellThrough = available > 0 ? expense / available : 0;

    const first = group[0];

    return {
      sourceRow: first.sourceRow,
      point: unique(group.map(line => line.point || "")).join(", "),
      sku: first.sku,
      name: first.name,
      category: first.category,
      start,
      receipt,
      available,
      expense,
      retailSales: sumOrNull("retailSales"),
      buyerSales: sumOrNull("buyerSales"),
      end,
      turnover: Number(turnover.toFixed(3)),
      stockDays: Number(stockDays.toFixed(1)),
      sellThrough: Number(sellThrough.toFixed(3)),
      recommendedOrder: computeRecommendedOrder(
        { expense, available, end, retailSales: null, buyerSales: null, turnover, stockDays, sellThrough },
        options
      )
    };
  });
}

/**
 * Читает отчёт целиком: каждая вкладка — своя точка. Книга из одного листа
 * ведёт себя как раньше, точка пустая.
 * @param {string} filePath
 * @param {SalesOrderOptions} options
 * @returns {{ lines: SalesOrderLine[], stats: SalesOrderStats }}
 */
function readReport(filePath, options) {
  // Только вкладки настоящей выгрузки: рабочие листы человека («40% і більше»,
  // «Замовлення») раньше становились отдельными точками и удваивали заказ.
  const sheets = selectReportSheets(readSheetMatrices(filePath, { raw: true }));
  /** @type {SalesOrderLine[]} */
  const lines = [];
  const stats = {
    productRows: 0,
    categoryMatched: 0,
    prefixMatched: 0,
    withSales: 0,
    lowSellThrough: 0,
    overstocked: 0
  };

  for (const sheet of sheets) {
    const point = sheetPointName(sheet.name, sheets.length) || "";
    const parsed = readReportSheet(sheet, options, point);

    lines.push(...parsed.lines);

    for (const key of Object.keys(stats)) {
      stats[key] += parsed.stats[key];
    }
  }

  const combined = combineSheetLines(lines, options);

  combined.sort((first, second) => {
    // Заказ, суженный до категорий, закупщик читает категориями: сначала все
    // презервативы, потом все лубриканты. В обычном заказе категория есть не у
    // каждой строки, и группировать по ней нечего — там порядок брендовый.
    const categoryDiff = options.categoriesOnly
      ? options.categories.indexOf(first.category) -
        options.categories.indexOf(second.category)
      : 0;

    if (categoryDiff !== 0) {
      return categoryDiff;
    }

    const rankDiff =
      getPrefixRank(first.sku, options.skuPrefixes) -
      getPrefixRank(second.sku, options.skuPrefixes);

    if (rankDiff !== 0) {
      return rankDiff;
    }

    // Внутри префикса строки идут точками, чтобы заказ читался по складам.
    if (first.point !== second.point) {
      return first.point < second.point ? -1 : 1;
    }

    return first.sourceRow - second.sourceRow;
  });

  return { lines: combined, stats };
}

/**
 * Позиция «стоит мёртвым грузом на этой точке»: продали меньше порога от того,
 * что было в наличии, либо остатка хватит дольше, чем товар вообще должен
 * лежать. Это ровно те строки, которые заказ отсеивает как непродающиеся, —
 * поэтому они и едут в другой магазин, а не заказываются заново.
 * @param {import("./transferByCriteria.js").PointMetrics} stock
 * @param {SalesOrderOptions} options
 * @param {number} maxStockDays
 * @returns {boolean}
 */
function isStuckStock(stock, options, maxStockDays) {
  return (
    stock.sellThrough < options.minSellThrough ||
    stock.stockDays > maxStockDays
  );
}

/**
 * Второй лист файла: всё, что не ушло в заказ, раскладывается по маршрутам
 * «откуда → кому». Считается по тому же отчёту, что и заказ, поэтому лист
 * пустеет, если в выгрузке одна торговая точка — везти физически некуда.
 * @param {string[]} files отчёты движения: заказ считается по первому,
 *   перемещение — по всем, иначе на одной точке возить не с чем
 * @param {SalesOrderLine[]} orderLines
 * @param {SalesOrderOptions} options
 * @returns {{ lines: Object[], stats: Object }}
 */
function buildOrderTransferPlan(files, orderLines, options) {
  const settings = resolveTransferSettings();
  /** @type {import("./deadStock.js").DeadStockRecord[]} */
  const records = [];

  for (const file of files) {
    records.push(...readReportFile(file).records);
  }

  const fresh = keepFreshestPointRecords(records, files);
  const bySku = buildPointMetrics(
    fresh.records,
    options.periodDays,
    settings.coverDays
  );
  // Артикул, попавший в заказ, из перемещения исключаем: одна и та же позиция
  // не должна одновременно докупаться и переезжать.
  const ordered = new Set(
    orderLines.map(line => normalizeSkuKey(line.sku)).filter(Boolean)
  );
  const plan = planTransfers(bySku, {
    sources: [],
    destinations: [],
    excluded: [],
    maxStockDays: settings.maxStockDays,
    minBatch: settings.minBatch,
    exclusions: settings.exclusions,
    isSource: stock =>
      !ordered.has(normalizeSkuKey(stock.sku)) &&
      isStuckStock(stock, options, settings.maxStockDays)
  });

  return {
    lines: plan.lines,
    stats: {
      filesRead: files.length,
      points: plan.points.size,
      skus: bySku.size,
      matched: plan.matched,
      noDestination: plan.noDestination,
      excluded: plan.excluded,
      leftAtSource: plan.leftAtSource,
      moves: plan.lines.length,
      units: plan.lines.reduce((sum, line) => sum + Number(line.qty), 0),
      coverDays: settings.coverDays,
      maxStockDays: settings.maxStockDays,
      minBatch: settings.minBatch
    }
  };
}

/**
 * @param {ExcelJS.Worksheet} worksheet
 * @param {number} columnNumber
 * @param {string} color
 * @returns {void}
 */
function fillColumn(worksheet, columnNumber, color) {
  worksheet.getColumn(columnNumber).eachCell(cell => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: {
        argb: color
      }
    };
  });
}

/**
 * @param {ExcelJS.Worksheet} worksheet
 * @returns {void}
 */
function styleWorksheet(worksheet) {
  worksheet.views = [
    {
      state: "frozen",
      ySplit: 1
    }
  ];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: worksheet.columnCount }
  };

  fillColumn(worksheet, 5, FILL_COLORS.available);
  fillColumn(worksheet, 7, FILL_COLORS.retailSales);
  fillColumn(worksheet, 9, FILL_COLORS.end);
  fillColumn(worksheet, 13, FILL_COLORS.order);

  worksheet.getRow(1).font = {
    bold: true
  };

  for (const column of [3, 4, 5, 6, 7, 8, 9]) {
    worksheet.getColumn(column).numFmt = "0.000";
  }

  worksheet.getColumn(10).numFmt = "#,##0.00";
  worksheet.getColumn(11).numFmt = "#,##0.0";
  worksheet.getColumn(12).numFmt = "0%";
  worksheet.getColumn(13).numFmt = "#,##0";

  worksheet.eachRow(row => {
    row.eachCell(cell => {
      cell.alignment = {
        vertical: "top",
        wrapText: false
      };
      cell.border = {
        bottom: {
          style: "thin",
          color: {
            argb: "FFE5E7EB"
          }
        }
      };
    });
  });
}

/**
 * Excel-формула для колонки «Заказ» (столбец M выходного файла).
 * F — Расход, I — Конец. Держи её согласованной с computeRecommendedOrder:
 * baseline там — это `ceil(Расход*targetPeriods - Конец)`, ровно эта формула.
 * Меняешь модель заказа — меняй оба места, иначе кэш и живой пересчёт разойдутся.
 * @param {number} rowNumber
 * @param {SalesOrderOptions} options
 * @returns {string}
 */
function buildOrderFormula(rowNumber, options) {
  const core = `MAX(0,ROUNDUP(F${rowNumber}*${options.targetPeriods}-I${rowNumber},0))`;

  return `IF(${core}=0,"",${core})`;
}

/**
 * @param {SalesOrderResult} result
 * @returns {Promise<string>}
 */
async function writeSalesOrderWorkbook(result) {
  const outputDir = path.resolve(process.cwd(), OUTPUT_DIR);
  const filePath = path.join(
    outputDir,
    `sales-order-t1-${createTimestamp()}.xlsx`
  );
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Замовлення");

  fs.mkdirSync(outputDir, {
    recursive: true
  });

  workbook.creator = "AI_Agent_Artik";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.calcProperties.forceFullCalc = true;

  // «Точка» дописывается последней и только когда точек правда несколько:
  // раскладка первых 13 колонок повторяет привычную выгрузку 1С, сдвигать её
  // нельзя — на индексы завязаны заливка, форматы и формула заказа.
  const points = new Set(
    result.lines.map(line => line.point).filter(Boolean)
  );
  const withPoint = points.size > 1;

  worksheet.columns = [
    { header: "Місце зберігання", key: "sku", width: 16 },
    { header: "", key: "name", width: 72 },
    { header: "Начало", key: "start", width: 11 },
    { header: "Приход", key: "receipt", width: 11 },
    { header: "", key: "available", width: 11 },
    { header: "Расход", key: "expense", width: 11 },
    { header: "Отчет о розничных продажах", key: "retailSales", width: 14 },
    { header: "Продажа покупателю", key: "buyerSales", width: 14 },
    { header: "Конец", key: "end", width: 11 },
    { header: "", key: "turnover", width: 10 },
    { header: "", key: "stockDays", width: 10 },
    { header: "", key: "sellThrough", width: 10 },
    { header: "Заказ", key: "orderQuantity", width: 10 },
    ...(withPoint ? [{ header: "Точка", key: "point", width: 12 }] : []),
    { header: "Категорія", key: "category", width: 16 }
  ];

  for (const line of result.lines) {
    const row = worksheet.addRow({
      sku: line.sku,
      name: line.name,
      start: valueOrEmpty(line.start),
      receipt: valueOrEmpty(line.receipt),
      available: valueOrEmpty(line.available),
      expense: valueOrEmpty(line.expense),
      retailSales: valueOrEmpty(line.retailSales),
      buyerSales: valueOrEmpty(line.buyerSales),
      end: valueOrEmpty(line.end),
      turnover: valueOrEmpty(line.turnover),
      stockDays: valueOrEmpty(line.stockDays),
      sellThrough: valueOrEmpty(line.sellThrough),
      point: withPoint ? line.point || "" : undefined,
      category: line.category || ""
    });
    const rowNumber = row.number;

    row.getCell("orderQuantity").value = {
      formula: buildOrderFormula(rowNumber, result.options),
      result: line.recommendedOrder || ""
    };
  }

  styleWorksheet(worksheet);
  addTransferSheet(workbook, result);

  await workbook.xlsx.writeFile(filePath);

  return filePath;
}

/**
 * Лист «Переміщення»: всё, что мы у поставщика не заказываем. Лист создаётся
 * всегда — пустая таблица с объяснением честнее отсутствующего листа: иначе
 * непонятно, посчитали перемещение или забыли.
 * @param {ExcelJS.Workbook} workbook
 * @param {SalesOrderResult} result
 * @returns {void}
 */
function addTransferSheet(workbook, result) {
  const worksheet = workbook.addWorksheet("Переміщення");
  const transfer = result.transfer || { lines: [], stats: {} };

  worksheet.columns = [
    { header: "Зі складу", key: "from", width: 10 },
    { header: "На склад", key: "to", width: 10 },
    { header: "Артикул", key: "sku", width: 18 },
    { header: "Назва", key: "name", width: 60 },
    { header: "Кількість", key: "qty", width: 11 },
    { header: "Реалізація джерела", key: "sellThrough", width: 19 },
    { header: "Залишок джерела", key: "sourceStock", width: 17 },
    { header: "Продажі отримувача", key: "destSales", width: 19 },
    { header: "Залишок отримувача", key: "destStock", width: 19 },
    { header: "Запас отримувача, дн", key: "destStockDays", width: 21 },
    { header: "Потрібно отримувачу", key: "destNeed", width: 20 },
    { header: "Магазин-джерело", key: "fromName", width: 30 },
    { header: "Магазин-отримувач", key: "toName", width: 30 }
  ];

  for (const line of transfer.lines) {
    worksheet.addRow(line);
  }

  worksheet.getRow(1).font = { bold: true };
  worksheet.getColumn(6).numFmt = "0%";
  worksheet.views = [{ state: "frozen", ySplit: 1 }];

  if (transfer.lines.length > 0) {
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: worksheet.columnCount }
    };

    return;
  }

  worksheet.addRow({
    from: "",
    to: "",
    sku: "",
    name: transferEmptyReason(result)
  });
}

/**
 * @param {SalesOrderResult} result
 * @returns {string}
 */
function transferEmptyReason(result) {
  const stats = (result.transfer && result.transfer.stats) || {};

  if (!stats.points || stats.points < 2) {
    return "У звіті одна торгова точка — везти нема куди. " +
      "Надішли вивантаження інших магазинів разом із цим.";
  }

  if (stats.matched > 0) {
    return `Позицій без замовлення, що стоять на місці: ${stats.matched}, ` +
      "але отримувача не знайшлося: потрібен магазин, де товар продається " +
      `і запасу менше ${stats.maxStockDays} дн.`;
  }

  return "Усе, що не потрапило в замовлення, продається нормально — " +
    "перевозити нема чого.";
}

/**
 * Свой разбор входа: замовлення Т1 работает с ОДНИМ файлом-отчётом, поэтому
 * поля files/outDir из общего ExcelRequest ему не нужны.
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
    return {
      query: String(input.query || ""),
      memories: Array.isArray(input.memories) ? input.memories : [],
      chatId: input.chatId ? String(input.chatId) : null
    };
  }

  return {
    query: "",
    memories: [],
    chatId: null
  };
}

/**
 * Человекочитаемое объяснение, почему из отчёта не собралось ни одной строки.
 * @param {SalesOrderStats} stats
 * @param {SalesOrderOptions} options
 * @returns {string[]}
 */
function describeEmptyReport(stats, options) {
  const prefixes = options.skuPrefixes.join(", ");

  if (stats.productRows === 0) {
    return [
      "В файле не нашлось строк с артикулом и наименованием.",
      "Похоже, это не отчёт о движении/розничных продажах."
    ];
  }

  if (options.categoriesOnly && stats.categoryMatched === 0) {
    return [
      `Товарных строк: ${stats.productRows}, но ни одна не относится к ` +
        `категориям ${options.categories.join(", ")}.`,
      "Заказ сужен по твоей просьбе. Нужен заказ по всему товару — напиши " +
        "«заказ поставщику весь товар».",
      "Слова-признаки категорий — в config.yaml, supply_settings.order_categories."
    ];
  }

  if (stats.prefixMatched === 0) {
    return [
      `Подходящих строк: ${stats.categoryMatched}, ` +
        `но ни один артикул не начинается с ${prefixes}.`,
      "Уточни префиксы прямо в запросе: замовлення prefixes=SO,PR <файл>.",
      "Префиксы перечисляются через запятую."
    ];
  }

  if (stats.withSales === 0) {
    return [
      `Позиций в отборе: ${stats.prefixMatched}, ` +
        "но у всех расход за период равен нулю.",
      "Проверь, что в отчёте есть колонка «Расход» с данными за период."
    ];
  }

  const percent = Math.round(options.minSellThrough * 100);

  if (stats.lowSellThrough === stats.withSales) {
    return [
      `Все ${stats.withSales} продающих позиций отсеклись: реализация ниже ${percent}%.`,
      `Снизь порог: замовлення продаж%=20 <файл> (сейчас ${percent}%).`
    ];
  }

  return [
    `Из ${stats.withSales} продающих позиций ${stats.lowSellThrough} ниже ${percent}% реализации, ` +
      `остальные отсеклись как затоваренные (запас больше ${options.maxStockDays} дн.).`,
    "Подними лимит запаса: замовлення days=90 <файл>."
  ];
}

/**
 * @param {unknown} input
 * @returns {Promise<SalesOrderResult>}
 */
export async function prepareSalesOrder(input) {
  const request = normalizeInput(input);
  const sourceFile = findReportFile(
    request.query,
    request.memories,
    request.chatId
  );
  const options = parseOptions(request.query, sourceFile || "");

  if (!sourceFile) {
    return {
      status: "needs_file",
      sourceFile: null,
      outputPath: null,
      options,
      lines: [],
      summary: {
        lines: 0,
        recommendedTotal: 0
      },
      notes: [
        "Не нашёл Excel-файл отчёта Т1.",
        "Укажи файл в команде или отправь отчёт боту в Telegram.",
        "Пример: /excel замовлення data/t1.xlsx"
      ]
    };
  }

  const { lines, stats } = readReport(sourceFile, options);
  /** @type {{ lines: Object[], stats: Object, error?: string }} */
  let transfer;

  try {
    transfer = buildOrderTransferPlan(
      findTransferFiles(
        request.query,
        request.memories,
        request.chatId,
        sourceFile
      ),
      lines,
      options
    );
  } catch (error) {
    // Перемещение — вторая половина файла, но не повод потерять заказ.
    transfer = {
      lines: [],
      stats: {},
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const result = {
    status: lines.length > 0 || transfer.lines.length > 0 ? "success" : "empty",
    sourceFile,
    outputPath: null,
    options,
    lines,
    transfer,
    summary: {
      lines: lines.length,
      recommendedTotal: lines.reduce(
        (sum, line) => sum + line.recommendedOrder,
        0
      )
    },
    stats,
    notes: []
  };

  if (transfer.error) {
    result.notes.push(`Лист перемещения не собрался: ${transfer.error}`);
  }

  if (result.status === "empty") {
    result.notes.push(...describeEmptyReport(stats, options));

    return result;
  }

  if (lines.length === 0) {
    result.notes.push(
      "Заказывать нечего: " + describeEmptyReport(stats, options)[0]
    );
  }

  result.outputPath = await writeSalesOrderWorkbook(result);

  return result;
}

/**
 * @param {SalesOrderResult} result
 * @returns {string}
 */
export function formatSalesOrderResult(result) {
  if (result.status === "needs_file") {
    return result.notes.join("\n");
  }

  if (result.status === "empty") {
    return [
      "Замовлення Т1 не сформировано.",
      ...result.notes,
      `Источник: ${result.sourceFile}`
    ].join("\n");
  }

  const stats = result.stats || {};
  const percent = Math.round(result.options.minSellThrough * 100);
  const soldShare = stats.prefixMatched
    ? Math.round((stats.withSales / stats.prefixMatched) * 100)
    : 0;
  const transfer = result.transfer || { lines: [], stats: {} };
  const moveStats = transfer.stats || {};
  const notMine = (stats.productRows || 0) - (stats.categoryMatched || 0);

  return [
    "Замовлення Т1 подготовлено.",
    `Excel-файл: ${result.outputPath}`,
    `Лист «Замовлення» (${result.options.categoriesOnly
      ? result.options.categories.join(" + ")
      : "весь товар"}): ` +
      `${result.summary.lines} позиций, ${result.summary.recommendedTotal} ед. к заказу`,
    `Лист «Переміщення»: ${moveStats.moves || 0} строк, ${moveStats.units || 0} ед. ` +
      `по ${moveStats.points || 0} точкам (выгрузок в расчёте: ${moveStats.filesRead || 0})`,
    ...(transfer.lines.length === 0
      ? [`  ${transferEmptyReason(result)}`]
      : []),
    `Продажи: ${stats.withSales || 0} из ${stats.prefixMatched || 0} артикулов (${soldShare}%), ` +
      `непродажи — ${100 - soldShare}%`,
    `Отсеяно из заказа: ` +
      (result.options.categoriesOnly ? `не та категория — ${notMine}, ` : "") +
      `<${percent}% реализации — ${stats.lowSellThrough || 0}, ` +
      `затоварено — ${stats.overstocked || 0}`,
    result.options.categoriesOnly
      ? `Заказ сужен до категорий: ${result.options.categories.join(", ")}. ` +
        "Нужен весь товар — напиши «заказ поставщику весь товар»."
      : "Заказ по всему товару. Нужны только презервативы и лубриканты — " +
        "напиши «заказ только презервативы и лубриканты» или нажми кнопку " +
        "«🧴 Заказ: презервативы + лубриканты».",
    `Фильтр заказа: реализация от ${percent}%, запас до ${result.options.maxStockDays} дней` +
      (result.options.prefixFilter
        ? `, артикулы ${result.options.prefixFilter.join(", ")}`
        : ""),
    `Период отчёта: ${result.options.periodDays} дн., запас на ${result.options.targetPeriods} периода(ов)`,
    ...result.notes.map(note => `  ${note}`),
    `Источник: ${toProjectPath(resolveProjectPath(result.sourceFile))}`
  ].join("\n");
}

export default {
  run: async input => formatSalesOrderResult(
    await prepareSalesOrder(input)
  )
};
