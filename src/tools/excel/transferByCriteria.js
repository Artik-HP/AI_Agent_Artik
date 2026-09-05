import {
  createTimestamp,
  normalizeInput,
  resolveFiles
} from "./shared.js";
import { writeReportWorkbook } from "./writer.js";
import { normalizeSkuKey, readReportFile } from "./deadStock.js";
import { allocateProportionally } from "./redistribute.js";
import { loadSupplySettings, loadTransferSettings } from "./reportGenerator.js";
import {
  comparePointCodes,
  normalizePointCode,
  parseDestinationPoint,
  parseSourcePoint,
  pointName
} from "./points.js";

// Разбор складов из текста запроса живёт в реестре точек: там же лежит
// сопоставление «Toppers 01 Lviv Gnatuka» ↔ «Т1», без которого «перенеси с Т1»
// не находило ни одной строки.
export { parseSourcePoint, parseDestinationPoint };

const FALLBACK_PERIOD_DAYS = 14;

/**
 * @typedef {Object} PointMetrics
 * @property {string} code канонический код точки: «Т1», «Х2»
 * @property {string} point как точка названа в отчёте
 * @property {string} sku
 * @property {string} name
 * @property {number} retail розничные продажи за период
 * @property {number} wholesale продажи покупателю за период
 * @property {number} end остаток на конец периода
 * @property {number} available начало + приход
 * @property {number} expense расход за период
 * @property {number} sellThrough расход / доступно, 0..1
 * @property {number} stockDays на сколько дней хватит ОСТАТКА при текущей скорости
 * @property {number} need сколько единиц не хватает до целевого покрытия
 */

/**
 * @typedef {Object} Criterion
 * @property {string} field поле PointMetrics
 * @property {string} title человеческое название для отчёта
 * @property {boolean} percent показывать как проценты
 * @property {string} op
 * @property {number} value
 */

/**
 * @typedef {Object} CriteriaMoveResult
 * @property {"success"|"empty"|"needs_file"|"needs_criteria"} status
 * @property {string[]} files
 * @property {string|null} source склад-источник, null = любой подходящий
 * @property {Criterion[]} criteria
 * @property {Object[]} lines
 * @property {string|null} outputPath
 * @property {Object} stats
 * @property {string[]} notes
 */

/**
 * Критерии отбора. Реализация стоит первой: «продаж%» должно опознаваться как
 * процент, а не как штуки.
 */
const CRITERIA = [
  {
    field: "sellThrough",
    title: "Реализация",
    percent: true,
    pattern: "реализац|реалізац|sell[ -]?through"
  },
  {
    field: "retail",
    title: "Продажи, шт",
    percent: false,
    pattern: "продаж|продал|sales"
  },
  {
    field: "end",
    title: "Остаток",
    percent: false,
    pattern: "остат|залиш|stock"
  },
  {
    field: "stockDays",
    title: "Дней запаса",
    percent: false,
    pattern: "запас|дней|днів|days"
  }
];

const OPERATORS = {
  "<": (left, right) => left < right,
  "<=": (left, right) => left <= right,
  ">": (left, right) => left > right,
  ">=": (left, right) => left >= right,
  "=": (left, right) => left === right
};

const WORD_OPERATORS = {
  "меньше": "<",
  "менее": "<",
  "менше": "<",
  "больше": ">",
  "более": ">",
  "більше": ">"
};

/**
 * Достаёт условия вида «реализация<20%», «остаток > 10», «продаж меньше 3»,
 * «запас>60». Несколько условий работают через И.
 * @param {string} query
 * @returns {Criterion[]}
 */
export function parseCriteria(query) {
  const text = String(query || "").toLowerCase();
  /** @type {Criterion[]} */
  const found = [];

  for (const criterion of CRITERIA) {
    const match = text.match(new RegExp(
      `(?:${criterion.pattern})[\\p{L}]*\\s*` +
      "(<=|>=|<|>|=|меньше|менее|менше|больше|более|більше)\\s*" +
      "(\\d+(?:[.,]\\d+)?)\\s*(%?)",
      "u"
    ));

    if (!match) {
      continue;
    }

    const op = WORD_OPERATORS[match[1]] || match[1];
    let value = Number(match[2].replace(",", "."));

    // «20%» и «20» для реализации значат одно и то же, а «0.2» — уже доля.
    if (criterion.percent && (match[3] === "%" || value > 1)) {
      value /= 100;
    }

    found.push({
      field: criterion.field,
      title: criterion.title,
      percent: criterion.percent,
      op,
      value
    });
  }

  return found;
}

/**
 * Длина периода отчёта. Порядок источников — от самого надёжного к самому
 * общему: слово пользователя («период=730»), диапазон дат в имени файла
 * («16.08-2.09.2026»), словесный срок («за 2 роки» — так назван реальный файл
 * годовой выгрузки), и только потом дефолт из config.yaml.
 *
 * Период — не косметика: от него считаются «дней запаса», а по ним отбираются
 * получатели. Выгрузку за два года, принятую за 18 дней, бот счёл бы сетью,
 * которая вот-вот останется без товара.
 * @param {string[]} files
 * @param {string} [query]
 * @returns {{ days: number, source: "запрос"|"даты в имени файла"|"срок в названии"|"config.yaml" }}
 */
export function resolvePeriod(files, query = "") {
  const fallback = loadSupplySettings().default_period_days || FALLBACK_PERIOD_DAYS;
  const text = `${query} ${files.join(" ")}`;

  const explicit = String(query).match(
    /(?:период|перiод|період|дней|дни|днів|days)\s*[:=]?\s*(\d{1,4})/i
  );

  if (explicit) {
    const days = Number(explicit[1]);

    if (days >= 1 && days <= 1500) {
      return { days, source: "запрос" };
    }
  }

  const range = text.match(
    /(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?\s*[-–—]\s*(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?/
  );

  if (range) {
    const now = new Date();
    const fromYear = Number(range[3] || range[6]) || now.getFullYear();
    const toYear = Number(range[6] || range[3]) || fromYear;
    const from = new Date(fromYear, Number(range[2]) - 1, Number(range[1]));
    const to = new Date(toYear, Number(range[5]) - 1, Number(range[4]));
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;

    if (days >= 1 && days <= 180) {
      return { days, source: "даты в имени файла" };
    }
  }

  const spelled = text.match(
    /за\s+(\d{1,2})\s*(рок|рік|год|лет|мес|міс|month|year)/i
  );

  if (spelled) {
    const unit = spelled[2].toLowerCase();
    const perUnit = /мес|міс|month/.test(unit) ? 30 : 365;

    return { days: Number(spelled[1]) * perUnit, source: "срок в названии" };
  }

  return { days: fallback, source: "config.yaml" };
}

/**
 * Схлопывает строки одного товара на одной точке и считает метрики. Движение
 * (расход, приход, продажи) складывается, снимки (начало, конец) берутся
 * максимальные — один склад может встретиться в двух пересекающихся выгрузках.
 *
 * Ключ точки — канонический код, а не текст: одна и та же Т1 приходит и
 * строкой-складом «Toppers 01 Lviv Gnatuka», и именем файла «Т1 6.08-23.08»,
 * и без склейки считалась бы двумя разными магазинами.
 * @param {import("./deadStock.js").DeadStockRecord[]} records
 * @param {number} periodDays
 * @param {number} coverDays на сколько дней продаж наполняем получателя
 * @returns {Map<string, Map<string, PointMetrics>>} sku -> код точки -> метрики
 */
function groupBySkuAndPoint(records, periodDays, coverDays) {
  /** @type {Map<string, Map<string, PointMetrics>>} */
  const bySku = new Map();

  for (const record of records) {
    const key = normalizeSkuKey(record.sku);

    if (!key) {
      continue;
    }

    let points = bySku.get(key);

    if (!points) {
      points = new Map();
      bySku.set(key, points);
    }

    const code = normalizePointCode(record.point) || record.point;
    const existing = points.get(code);

    if (!existing) {
      points.set(code, {
        code,
        point: record.point,
        sku: record.sku,
        name: record.name,
        retail: record.retail,
        wholesale: record.wholesale,
        end: record.end,
        available: record.start + record.receipt,
        expense: record.expense,
        sellThrough: 0,
        stockDays: 0,
        need: 0
      });
      continue;
    }

    existing.retail += record.retail;
    existing.wholesale += record.wholesale;
    existing.expense += record.expense;
    existing.available = Math.max(existing.available, record.start + record.receipt);
    existing.end = Math.max(existing.end, record.end);
    existing.name = existing.name || record.name;
  }

  for (const points of bySku.values()) {
    for (const metrics of points.values()) {
      metrics.sellThrough = metrics.available > 0
        ? metrics.expense / metrics.available
        : 0;
      // Расхода нет — остаток не кончится никогда. Infinity честнее нуля:
      // такая позиция обязана проходить условие «запас > N дней».
      metrics.stockDays = metrics.expense > 0
        ? (metrics.end * periodDays) / metrics.expense
        : Infinity;
      // Потребность получателя той же природы, что и заказ поставщику:
      // сколько довезти, чтобы хватило на coverDays дней его же продаж.
      metrics.need = Math.max(
        0,
        Math.ceil((metrics.retail / periodDays) * coverDays - metrics.end)
      );
    }
  }

  return bySku;
}

/**
 * @param {PointMetrics} metrics
 * @param {Criterion[]} criteria
 * @returns {boolean}
 */
function matchesCriteria(metrics, criteria) {
  return criteria.every(criterion => {
    const compare = OPERATORS[criterion.op];
    const value = metrics[criterion.field];

    return typeof compare === "function" && compare(value, criterion.value);
  });
}

/**
 * @param {Criterion} criterion
 * @returns {string}
 */
export function formatCriterion(criterion) {
  const value = criterion.percent
    ? `${Math.round(criterion.value * 100)}%`
    : criterion.value;

  return `${criterion.title} ${criterion.op} ${value}`;
}

/**
 * Компилирует список «не переносить» из config.yaml. Кривой шаблон не должен
 * ронять отчёт — он просто выпадает из списка.
 * @param {unknown} patterns
 * @returns {RegExp[]}
 */
function compileExclusions(patterns) {
  if (!Array.isArray(patterns)) {
    return [];
  }

  /** @type {RegExp[]} */
  const compiled = [];

  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(String(pattern), "i"));
    } catch {
      // Кривой шаблон игнорируем.
    }
  }

  return compiled;
}

/**
 * @param {CriteriaMoveResult} result
 * @param {string|null} outDir
 * @returns {Promise<string>}
 */
async function writeWorkbook(result, outDir) {
  return await writeReportWorkbook({
    fileName: `perenos-po-kriteriyam-${createTimestamp()}`,
    sheetName: "Перенос",
    outDir,
    columns: [
      { header: "Со склада", key: "from", width: 10 },
      { header: "На склад", key: "to", width: 10 },
      { header: "Артикул", key: "sku", width: 18 },
      { header: "Название", key: "name", width: 44 },
      { header: "Кол-во", key: "qty", width: 9 },
      { header: "Реализация источника", key: "sellThrough", width: 20, numFmt: "0%" },
      { header: "Остаток источника", key: "sourceStock", width: 18 },
      { header: "Продажи получателя", key: "destSales", width: 18 },
      { header: "Остаток получателя", key: "destStock", width: 18 },
      { header: "Запас получателя, дн", key: "destStockDays", width: 20 },
      { header: "Нужно получателю", key: "destNeed", width: 17 },
      { header: "Магазин-источник", key: "fromName", width: 30 },
      { header: "Магазин-получатель", key: "toName", width: 30 }
    ],
    rows: result.lines
  });
}

/**
 * @typedef {Object} TransferPlanOptions
 * @property {string|null} source откуда везём; null — любая подходящая точка
 * @property {string|null} destination куда везём; null — кому товар нужен
 * @property {number} maxStockDays получатель нуждается, если запаса меньше
 * @property {number} minBatch минимальная партия в строке перемещения
 * @property {RegExp[]} exclusions артикулы, которые не возим вообще
 * @property {(stock: PointMetrics) => boolean} isSource годится ли точка как источник
 */

/**
 * Раскладывает остатки по маршрутам «откуда → кому». Источник задаётся
 * предикатом: «перенеси где реализация<20%» передаёт сюда проверку критериев,
 * заказ поставщику — «этой позиции нет в заказе, значит её надо возить».
 *
 * Получатель — магазин, которому товар реально нужен: он его продаёт, запаса
 * у него меньше maxStockDays дней и до целевого покрытия не хватает единиц.
 * Везём столько, сколько получателю нужно, но не больше, чем лежит у
 * источника; при дефиците делим пропорционально потребностям.
 * @param {Map<string, Map<string, PointMetrics>>} bySku
 * @param {TransferPlanOptions} options
 * @returns {{ lines: Object[], points: Set<string>, matched: number, noDestination: number, excluded: number, leftAtSource: number }}
 */
export function planTransfers(bySku, options) {
  /** @type {Object[]} */
  const lines = [];
  const points = new Set();
  let matched = 0;
  let noDestination = 0;
  let excluded = 0;
  let leftAtSource = 0;

  for (const pointMap of bySku.values()) {
    const stocks = [...pointMap.values()];

    stocks.forEach(stock => points.add(stock.code));

    // Сертификаты и прочее «не товар» между магазинами не возят.
    if (options.exclusions.some(pattern => pattern.test(stocks[0].sku))) {
      excluded += 1;
      continue;
    }

    const sources = stocks.filter(stock =>
      (!options.source || stock.code === options.source) &&
      stock.end > 0 &&
      options.isSource(stock)
    );

    for (const from of sources) {
      matched += 1;

      // «Нужный toppers»: товар у него продаётся, запас скоро кончится и до
      // целевого покрытия действительно не хватает штук.
      const destinations = stocks
        .filter(stock =>
          stock.code !== from.code &&
          (!options.destination || stock.code === options.destination) &&
          stock.retail > 0 &&
          stock.stockDays < options.maxStockDays &&
          stock.need > 0
        )
        .sort((first, second) => second.need - first.need);

      if (destinations.length === 0) {
        noDestination += 1;
        continue;
      }

      const supply = Math.floor(from.end);

      if (supply < 1) {
        continue;
      }

      const needs = destinations.map(stock => stock.need);
      const totalNeed = needs.reduce((sum, value) => sum + value, 0);
      // Хватает на всех — каждый получает ровно свою потребность, излишек
      // остаётся на источнике. Не хватает — делим пропорционально нужде.
      const quantities = supply >= totalNeed
        ? needs
        : allocateProportionally(supply, needs);
      let shipped = 0;

      destinations.forEach((target, index) => {
        const qty = quantities[index];

        // Партия меньше минимальной не окупает поездку между магазинами.
        if (qty < options.minBatch) {
          return;
        }

        shipped += qty;

        lines.push({
          from: from.code,
          to: target.code,
          sku: from.sku,
          name: from.name || target.name,
          qty,
          sellThrough: Number(from.sellThrough.toFixed(3)),
          sourceStock: from.end,
          destSales: target.retail,
          destStock: target.end,
          destStockDays: Number.isFinite(target.stockDays)
            ? Math.round(target.stockDays)
            : "",
          destNeed: target.need,
          fromName: pointName(from.code),
          toName: pointName(target.code)
        });
      });

      leftAtSource += supply - shipped;
    }
  }

  lines.sort((first, second) =>
    comparePointCodes(first.from, second.from) ||
    String(first.sku).localeCompare(String(second.sku)) ||
    comparePointCodes(first.to, second.to)
  );

  return { lines, points, matched, noDestination, excluded, leftAtSource };
}

/**
 * Собирает метрики по точкам из уже прочитанных строк отчёта. Вынесено ради
 * заказа поставщику: ему нужен тот же расклад «артикул → точка → метрики»,
 * что и переносу по критериям.
 * @param {import("./deadStock.js").DeadStockRecord[]} records
 * @param {number} periodDays
 * @param {number} coverDays
 * @returns {Map<string, Map<string, PointMetrics>>}
 */
export function buildPointMetrics(records, periodDays, coverDays) {
  return groupBySkuAndPoint(records, periodDays, coverDays);
}

/**
 * Настройки переноса в готовом к употреблению виде: числа приведены,
 * шаблоны исключений скомпилированы.
 * @returns {{ coverDays: number, maxStockDays: number, minBatch: number, exclusions: RegExp[] }}
 */
export function resolveTransferSettings() {
  const settings = loadTransferSettings();

  return {
    coverDays: Math.max(0, Number(settings.cover_days) || 0),
    maxStockDays: Number(settings.max_stock_days) || Infinity,
    minBatch: Math.max(1, Number(settings.min_batch) || 1),
    exclusions: compileExclusions(settings.exclude_sku_patterns)
  };
}


/**
 * Переносит товар по заданным критериям: «перенеси с Т1 где реализация<20%».
 *
 * Источник — точка, подходящая под условие из запроса (без указания склада
 * рассматриваются все). Получатель — магазин, которому товар реально нужен:
 * он его продаёт, запаса у него меньше `max_stock_days` дней и до целевого
 * покрытия не хватает единиц. Везём столько, сколько получателю нужно, но не
 * больше, чем лежит у источника; при дефиците делим пропорционально
 * потребностям. Всё, что не разошлось, остаётся на источнике.
 * @param {unknown} input
 * @returns {Promise<CriteriaMoveResult>}
 */
export async function buildCriteriaTransfer(input) {
  const request = normalizeInput(input);
  const files = resolveFiles(request);
  const source = parseSourcePoint(request.query);
  const destination = parseDestinationPoint(request.query);
  const criteria = parseCriteria(request.query);

  if (files.length === 0) {
    return {
      status: "needs_file",
      files: [],
      source,
      destination,
      criteria,
      lines: [],
      outputPath: null,
      stats: {},
      notes: [
        "Не нашёл отчёты о продажах. Отправь боту выгрузки по точкам (Т1, Т2, … Х2)."
      ]
    };
  }

  if (criteria.length === 0) {
    // Без условия команда неотличима от «развезти по продажам»; лучше показать
    // синтаксис, чем молча увезти всё подряд.
    return {
      status: "needs_criteria",
      files,
      source,
      destination,
      criteria,
      lines: [],
      outputPath: null,
      stats: {},
      notes: [
        "Не понял критерий. Напиши условие явно, например:",
        "• «перенеси с Т1 где реализация<20%»",
        "• «перенеси где остаток>10 реализация<40%»",
        "• «перенеси с toppers 1 на т9 где продаж<3»",
        "• «перенеси где запас>60»",
        "Критерии: реализация (%), продаж (шт), остаток (шт), запас (дней).",
        "Считаю по всем точкам. Нужен один магазин — допиши: «перенеси с Т5 ...»."
      ]
    };
  }

  const settings = loadTransferSettings();
  const coverDays = Math.max(0, Number(settings.cover_days) || 0);
  const maxStockDays = Number(settings.max_stock_days) || Infinity;
  const minBatch = Math.max(1, Number(settings.min_batch) || 1);
  const exclusions = compileExclusions(settings.exclude_sku_patterns);
  const period = resolvePeriod(files, request.query);
  const periodDays = period.days;
  /** @type {import("./deadStock.js").DeadStockRecord[]} */
  const records = [];

  for (const file of files) {
    records.push(...readReportFile(file).records);
  }

  const bySku = groupBySkuAndPoint(records, periodDays, coverDays);
  const plan = planTransfers(bySku, {
    source,
    destination,
    maxStockDays,
    minBatch,
    exclusions,
    isSource: stock => matchesCriteria(stock, criteria)
  });
  const lines = plan.lines;
  const points = plan.points;
  const { matched, noDestination, excluded, leftAtSource } = plan;

  const stats = {
    filesRead: files.length,
    periodDays,
    periodSource: period.source,
    points: points.size,
    skus: bySku.size,
    matched,
    noDestination,
    excluded,
    leftAtSource,
    coverDays,
    maxStockDays,
    minBatch,
    moves: lines.length,
    units: lines.reduce((sum, line) => sum + Number(line.qty), 0)
  };

  /** @type {CriteriaMoveResult} */
  const result = {
    status: lines.length > 0 ? "success" : "empty",
    files,
    source,
    destination,
    criteria,
    lines,
    outputPath: null,
    stats,
    notes: []
  };

  if (lines.length === 0) {
    result.notes.push(
      source
        ? `На складе ${source} нет позиций, подходящих под условие.`
        : "Ни одна позиция не подошла под условие."
    );

    if (matched > 0) {
      result.notes.push(
        `Под условие подошло позиций: ${matched}, но получателя не нашлось: ` +
        `нужен магазин, где товар продаётся и запаса меньше ${maxStockDays} дн.`
      );
    }

    return result;
  }

  result.outputPath = await writeWorkbook(result, request.outDir);

  return result;
}

/**
 * @param {CriteriaMoveResult} result
 * @returns {string}
 */
export function formatCriteriaTransferResult(result) {
  if (result.status === "needs_file" || result.status === "needs_criteria") {
    return result.notes.join("\n");
  }

  const conditions = result.criteria.map(formatCriterion).join(", ");

  if (result.status === "empty") {
    return [
      "Перенос не собран.",
      `Условие: ${conditions}`,
      ...result.notes
    ].join("\n");
  }

  const stats = result.stats;
  const from = result.source
    ? `${result.source} (${pointName(result.source)})`
    : "все точки";
  const to = result.destination
    ? `${result.destination} (${pointName(result.destination)})`
    : "кому товар нужен";

  return [
    "Перенос по критериям готов.",
    `Excel-файл: ${result.outputPath}`,
    `Условие: ${conditions}`,
    `Со склада: ${from}`,
    `На склад: ${to}`,
    `Файлов: ${stats.filesRead}, складов: ${stats.points}, период: ${stats.periodDays} дн.` +
      (stats.periodSource === "config.yaml"
        ? " — период не виден в данных, взят из config.yaml. Если он другой,"
          + " допиши «период=730»."
        : ` (${stats.periodSource})`),
    `Позиций подошло: ${stats.matched}, некуда везти: ${stats.noDestination}`,
    `Строк переноса: ${stats.moves}, единиц: ${stats.units}, ` +
      `осталось на источниках: ${stats.leftAtSource}`,
    `Получатель — где товар продаётся и запаса меньше ${stats.maxStockDays} дн.; ` +
      `везём запас на ${stats.coverDays} дн. его продаж, партия от ${stats.minBatch} шт.`
  ].join("\n");
}

export default {
  run: async input => formatCriteriaTransferResult(await buildCriteriaTransfer(input))
};
