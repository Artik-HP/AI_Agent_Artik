import { askModel } from "./model.js";

/**
 * @typedef {{ role: "system"|"user"|"assistant", content: string }} Message
 */

const CODEBASE_ANALYZER_PROMPT = `
Ты Codebase Analyzer для AI-агента.

Тебе уже передан снимок кодовой базы проекта. Не проси пользователя прислать код,
файлы или дополнительный контекст. Анализируй только то, что есть в результате
инструмента.

Твоя задача:
- провести практичное ревью проекта;
- найти архитектурные и кодовые проблемы;
- выделить сильные стороны;
- предложить порядок исправлений;
- отвечать на русском языке;
- писать конкретно и без пересказа всего сырого текста.

Формат ответа:

1. Краткий вывод
2. Архитектура проекта
3. Сильные стороны
4. Проблемы
5. Что исправить первым
6. Рекомендации по файлам
`.trim();

const GENERIC_ANALYZER_PROMPT = `
Ты Ranker/Analyzer для AI-агента.

Тебе уже передан результат инструмента. Не проси пользователя повторить запрос,
прислать ссылку или дать дополнительные данные, если ответ можно подготовить по
имеющемуся результату.

Твоя задача:
- убрать мусор;
- выбрать главное;
- не копировать весь сырой текст;
- отвечать на русском языке;
- писать кратко и полезно.
`.trim();

/**
 * @param {unknown} rawResult
 * @returns {string}
 */
function normalizeRawResult(rawResult) {
  if (typeof rawResult === "string") {
    return rawResult.trim();
  }

  if (rawResult == null) {
    return "";
  }

  try {
    return JSON.stringify(rawResult, null, 2);
  } catch {
    return String(rawResult);
  }
}

/**
 * Анализирует сырой результат инструмента и превращает его в полезный ответ.
 *
 * @param {string} userQuery
 * @param {string} toolName
 * @param {unknown} rawResult
 * @returns {Promise<string>}
 */
export async function analyzeResults(userQuery, toolName, rawResult) {
  const normalizedToolName = String(toolName || "unknown").trim();
  const normalizedResult = normalizeRawResult(rawResult);

  if (!normalizedResult) {
    return "Инструмент не вернул данных для анализа.";
  }

  /** @type {Message[]} */
  const messages = [
    {
      role: "system",
      content: normalizedToolName === "codebase"
        ? CODEBASE_ANALYZER_PROMPT
        : GENERIC_ANALYZER_PROMPT
    },
    {
      role: "user",
      content: `Запрос пользователя:
${userQuery}

Инструмент:
${normalizedToolName}

Сырые результаты:
${normalizedResult}`
    }
  ];

  return await askModel(
    messages,
    process.env.MODEL_DEFAULT
  );
}

export default analyzeResults;
