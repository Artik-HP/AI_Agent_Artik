import * as cheerio from "cheerio";

export async function readWebPage(url) {
  const response = await fetch(url);

  if (!response.ok) {
    return `Не удалось открыть страницу: ${response.status}`;
  }

  const html = await response.text();

  const $ = cheerio.load(html);

  $("script").remove();
  $("style").remove();

  const text = $("body")
    .text()
    .replace(/\s+/g, " ")
    .trim();

  return text.slice(0, 12000);
}

export default {
  async run(url) {
    return await readWebPage(url);
  }
};