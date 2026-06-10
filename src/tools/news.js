function decodeHtml(text) {
  // decodeHtml — чистим HTML-сущности

  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function extractTag(item, tag) {
  // extractTag — достать содержимое XML-тега

  const match = item.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  // ищем <title>...</title> или <link>...</link>

  if (!match) {
    return "";
  }

  return decodeHtml(
    match[1]
      .replace("<![CDATA[", "")
      .replace("]]>", "")
      .trim()
  );
}

export async function getNews(topic) {
  const query = String(topic || "").trim();

  if (!query) {
    return "Укажи тему. Например: /news AI";
  }

  try {
    const url =
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ru&gl=UA&ceid=UA:ru`;

    const response = await fetch(url);

    if (!response.ok) {
      return `Ошибка RSS: ${response.status}`;
    }

    const xml = await response.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
      .map(match => match[1]);

    const news = items
      .slice(0, 5)
      .map((item, index) => {
        const title = extractTag(item, "title");
        const link = extractTag(item, "link");

        return `${index + 1}. ${title}\n${link}`;
      })
      .filter(item => !item.includes("undefined"));

    if (news.length === 0) {
      return "Новости не найдены.";
    }

    return [
      `Новости по запросу: ${query}`,
      "",
      ...news
    ].join("\n\n");
  } catch (error) {
    return `Ошибка: ${error.message}`;
  }
}