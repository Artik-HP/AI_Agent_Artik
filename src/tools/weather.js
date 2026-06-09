/**
 * Возвращает погоду через wttr.in.
 *
 * @param {string} city
 * @returns {Promise<string>}
 */
export async function getWeather(city) {
  const normalizedCity = String(city || "").trim();
  // String(...) — превращаем city в строку
  // city || "" — если city пустой, берём пустую строку
  // trim() — убирает пробелы по краям

  if (!normalizedCity) {
    return "Укажи город. Например: /weather Луцк";
  }

  const url = `https://wttr.in/${encodeURIComponent(normalizedCity)}?format=3`;
  // encodeURIComponent() — безопасно кодирует город для URL
  // format=3 — короткий формат ответа

  try {
    const response = await fetch(url);
    // fetch — делает HTTP-запрос
    // await — ждём ответ

    if (!response.ok) {
      return `Ошибка погоды: ${response.status}`;
    }

    const weatherText = await response.text();
    // response.text() — читаем ответ как обычный текст

    return weatherText;
  } catch (error) {
    return `Не удалось получить погоду: ${error.message}`;
  }
}