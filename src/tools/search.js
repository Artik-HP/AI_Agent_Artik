import "dotenv/config";

/**
 * @typedef {Object} ResultItem
 * @property {string} title
 * @property {string} url
 * @property {string} content
 */

/**
 * @typedef {Object} TavilyResponse
 * @property {string} [answer]
 * @property {Array<ResultItem>} [results]
 * @property {{message?:string}} [error]
 */

const MAX_SUMMARY_ITEMS = 3;
const MAX_SUMMARY_LENGTH = 180;

/**
 * @param {string} value
 * @returns {string}
 */
function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} value
 * @param {number} maxLength
 * @returns {string}
 */
function shortenText(value, maxLength) {
  const text = cleanText(value);

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1).trim()}...`;
}

/**
 * @param {TavilyResponse} data
 * @returns {string}
 */
function formatSummary(data) {
  const answer = cleanText(data.answer || "");

  if (answer) {
    return answer;
  }

  const summaries = (data.results || [])
    .map(item => shortenText(item.content, MAX_SUMMARY_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_SUMMARY_ITEMS);

  if (summaries.length === 0) {
    return "Ничего по сути не найдено.";
  }

  return summaries
    .map((summary, index) => `${index + 1}. ${summary}`)
    .join("\n");
}

/**
 * @param {ResultItem[]} results
 * @returns {string}
 */
function formatSources(results) {
  const sources = results
    .filter(item => item.title && item.url)
    .map((item, index) => `${index + 1}. ${cleanText(item.title)}\n${item.url}`);

  return sources.length > 0
    ? sources.join("\n\n")
    : "Источники не найдены.";
}

/**
 * Выполняет поиск через API Tavily.
 * @param {string} query
 * @returns {Promise<string>} краткий ответ и ссылки на источники
 */
export async function searchWeb(query) {
  /** @type {string|undefined} */
  const apiKey = process.env.TAVILY_API_KEY;
  /** @type {string} */
  const normalizedQuery = String(query || "").trim();

  if (!normalizedQuery) {
    return "Напиши запрос. Например: /search что такое MCP";
  }

  if (!apiKey) {
    return "Нет TAVILY_API_KEY в .env";
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query: normalizedQuery,
      search_depth: "basic",
      max_results: 5,
      include_answer: true,
      include_raw_content: false
    })
  });

  /** @type {TavilyResponse} */
  const data = await response.json();

  if (!response.ok) {
    return data?.error?.message || `Ошибка Tavily: ${response.status}`;
  }

  return [
    `Поиск: ${normalizedQuery}`,
    "",
    "Коротко по сути:",
    formatSummary(data),
    "",
    "Источники:",
    "",
    formatSources(data.results || [])
  ].join("\n");
}
