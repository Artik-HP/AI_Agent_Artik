import { loadSupplySettings } from "./reportGenerator.js";

/**
 * Категории, которые закупаются у поставщика. Всё остальное между магазинами
 * перевозится, а не докупается — поэтому список короткий и закрытый.
 *
 * Ключ — как категория называется в отчёте, значение — слова, по которым она
 * узнаётся в наименовании. Переопределяется в config.yaml
 * (supply_settings.order_categories), чтобы правил их закупщик, а не код.
 */
const DEFAULT_ORDER_CATEGORIES = {
  "Презервативи": [
    "презерватив",
    "condom",
    "кондом"
  ],
  "Лубриканти": [
    "лубрикант",
    "змазк",
    "смазк",
    "мастил",
    "lubricant",
    "gleitgel"
  ]
};

/**
 * Артикул в 1С назван по схеме «категория + бренд + характеристики»:
 * «Лубрикант Swiss Navy NAKED 59 мл», «Набір презервативів ONE …».
 * Категория стоит в начале, поэтому ключевое слово ищем не где угодно,
 * а в голове названия: «Мастурбатор Tenga … з охолоджувальним лубрикантом» —
 * это мастурбатор, а не лубрикант.
 */
const DEFAULT_MATCH_WITHIN_CHARS = 45;

/**
 * Голова названия говорит, что это другой товар, даже если дальше по строке
 * встретится «змазка» или «лубрикант». Массажное масло с «MASSAGE LUBRICANT»
 * в названии — единственный регулярный случай, но он повторяется.
 */
const DEFAULT_EXCLUDE_KEYWORDS = [
  "масажна олія",
  "масажне масло",
  "массажное масло",
  "мастурбатор",
  "пінка",
  "пенка"
];

/**
 * @typedef {Object} OrderCategoryRules
 * @property {{ title: string, pattern: RegExp }[]} categories
 * @property {RegExp|null} exclude
 * @property {number} matchWithin сколько первых символов названия считаем «головой»
 */

/** @type {OrderCategoryRules|null} */
let cachedRules = null;

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function toKeywordList(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || "").split(/\s*,\s*/);

  return list.map(item => String(item).trim()).filter(Boolean);
}

/**
 * @param {string[]} keywords
 * @returns {RegExp|null}
 */
function buildPattern(keywords) {
  const escaped = keywords.map(keyword =>
    keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );

  return escaped.length > 0
    ? new RegExp(escaped.join("|"), "i")
    : null;
}

/**
 * Читает правила из config.yaml один раз за процесс: файл лежит рядом, но
 * классификатор зовут на каждую строку отчёта (это десятки тысяч вызовов).
 * @returns {OrderCategoryRules}
 */
function loadRules() {
  if (cachedRules) {
    return cachedRules;
  }

  const settings = loadSupplySettings();
  const configured = settings.order_categories;
  const source = configured && typeof configured === "object" && !Array.isArray(configured)
    ? configured
    : DEFAULT_ORDER_CATEGORIES;
  /** @type {{ title: string, pattern: RegExp }[]} */
  const categories = [];

  for (const [title, keywords] of Object.entries(source)) {
    const pattern = buildPattern(toKeywordList(keywords));

    if (pattern) {
      categories.push({ title, pattern });
    }
  }

  const excludeKeywords = configured
    ? toKeywordList(settings.order_category_exclude)
    : DEFAULT_EXCLUDE_KEYWORDS;
  const matchWithin = Number(settings.order_category_match_within);

  cachedRules = {
    categories: categories.length > 0
      ? categories
      : Object.entries(DEFAULT_ORDER_CATEGORIES).map(([title, keywords]) => ({
        title,
        pattern: /** @type {RegExp} */ (buildPattern(keywords))
      })),
    exclude: buildPattern(
      excludeKeywords.length > 0 ? excludeKeywords : DEFAULT_EXCLUDE_KEYWORDS
    ),
    matchWithin: Number.isFinite(matchWithin) && matchWithin > 0
      ? matchWithin
      : DEFAULT_MATCH_WITHIN_CHARS
  };

  return cachedRules;
}

/**
 * Сбрасывает кэш правил — нужен тестам, которые правят config.yaml на лету.
 * @returns {void}
 */
export function resetOrderCategoriesCache() {
  cachedRules = null;
}

/**
 * Названия категорий, которые вообще заказываем. Для текста ответа и заголовков.
 * @returns {string[]}
 */
export function orderCategoryTitles() {
  return loadRules().categories.map(category => category.title);
}

/**
 * К какой закупаемой категории относится товар.
 * @param {unknown} name наименование из отчёта
 * @returns {string|null} название категории или null — «это возим, а не заказываем»
 */
export function classifyOrderCategory(name) {
  const text = String(name || "").trim();

  if (!text) {
    return null;
  }

  const rules = loadRules();
  const head = text.slice(0, rules.matchWithin + 40);

  if (rules.exclude && rules.exclude.test(text.slice(0, rules.matchWithin))) {
    return null;
  }

  for (const category of rules.categories) {
    const at = head.search(category.pattern);

    if (at !== -1 && at <= rules.matchWithin) {
      return category.title;
    }
  }

  return null;
}

/**
 * Названа ли закупаемая категория в тексте запроса: «заказ только
 * презервативы и лубриканты», «замовлення тільки змазки». Проверяем по тем же
 * словам, что и наименования товаров, но БЕЗ окна позиции: в запросе категория
 * может стоять где угодно.
 * @param {unknown} query
 * @returns {boolean}
 */
export function mentionsOrderCategory(query) {
  const text = String(query || "");

  if (!text) {
    return false;
  }

  return loadRules().categories.some(category => category.pattern.test(text));
}

/**
 * @param {unknown} name
 * @returns {boolean}
 */
export function isOrderCategory(name) {
  return classifyOrderCategory(name) !== null;
}

export default {
  classifyOrderCategory,
  isOrderCategory,
  mentionsOrderCategory,
  orderCategoryTitles,
  resetOrderCategoriesCache
};
