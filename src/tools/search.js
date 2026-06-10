  import "dotenv/config"
/**
 * Ищет информацию в интернете через Tavily.
 *
 * @param {string} query
 * @returns {Promise<string>}
 */
 export async function searchWeb(query) {
  const normalizedQuery = String(query || "").trim();

  if (!normalizedQuery) {
    return "Напиши запрос. Например: /search JavaScript Promise";
  }
  const apiKey = process.env.TAVILY_API_KEY;

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

  const data = await response.json();

  if (!response.ok) {
    return data?.error?.message || `Ошибка Tavily: ${response.status}`;
  }

  const answer = data.answer
    ? [`Краткий ответ:\n${data.answer}`, ""]
    : [];

  const results = (data.results || [])
    .slice(0, 5)
    .map((item, index) => {
      return [
        `${index + 1}. ${item.title}`,
        item.url,
        item.content
      ].join("\n");
    });

  if (results.length === 0) {
    return "Ничего не найдено.";
  }

  return [
    `Поиск: ${normalizedQuery}`,
    "",
    ...answer,
    "Источники:",
    "",
    ...results
  ].join("\n\n");
}