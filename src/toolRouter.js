/**
 * Выбирает инструмент по обычному тексту пользователя.
 *
 * @param {string} text
 * @returns {{ tool: string, input: string } | null}
 */
export function routeTool(text) {
  const normalized = String(text || "").trim();
  const lower = normalized.toLowerCase();

  if (!normalized) {
    return null;
  }

  if (
    lower.includes("погод") ||
    lower.includes("температур") ||
    lower.startsWith("weather ")
  ) {
    const input = normalized
      .replace(/какая погода/gi, "")
      .replace(/погода/gi, "")
      .replace(/weather/gi, "")
      .replace(/в городе/gi, "")
      .replace(/^в\s+/gi, "")
      .trim();

    return {
      tool: "weather",
      input
    };
  }

  if (
    lower.includes("youtube") ||
    lower.includes("ютуб") ||
    lower.includes("видео") ||
    lower.includes("ролик")
  ) {
    const input = normalized
      .replace(/найди/gi, "")
      .replace(/покажи/gi, "")
      .replace(/видео/gi, "")
      .replace(/ролик/gi, "")
      .replace(/на youtube/gi, "")
      .replace(/на ютубе/gi, "")
      .replace(/ютуб/gi, "")
      .replace(/youtube/gi, "")
      .trim();

    return {
      tool: "youtube",
      input
    };
  }

  if (
    lower.includes("найди") ||
    lower.includes("поищи") ||
    lower.includes("поиск") ||
    lower.includes("что такое")
  ) {
    return {
      tool: "search",
      input: normalized
    };
  }

  return null;
}