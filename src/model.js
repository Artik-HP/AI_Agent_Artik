import "dotenv/config";
// автоматически загружает .env

/**
 * @typedef {Object} ChatMessage
 * @property {"system"|"user"|"assistant"} role
 * @property {string} content
 */

/**
 * @typedef {Object} OpenRouterChoice
 * @property {{content: string}} message
 */

/**
 * @typedef {Object} OpenRouterResponse
 * @property {OpenRouterChoice[]} choices
 * @property {{message: string}} [error]
 */

/**
 * Отправляет сообщения в OpenRouter.
 *
 * @param {ChatMessage[]} messages
 * @param {string} [selectedModel]
 * @returns {Promise<string>}
 */
export async function askModel(messages, selectedModel) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  const model =
    selectedModel ||
    process.env.MODEL_DEFAULT ||
    process.env.OPENROUTER_MODEL;

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY не найден в .env");
  }

  if (!model) {
    throw new Error("Модель не найдена в .env");
  }

  // дальше fetch...
  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },

      body: JSON.stringify({
        model,
        messages
      })
    }
  );

  /** @type {OpenRouterResponse} */
  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      `Ошибка API: ${response.status}`
    );
  }

  const answer =
    data?.choices?.[0]?.message?.content;

  if (!answer) {
    throw new Error(
      "Модель не вернула ответ."
    );
  }

  return answer;
}
