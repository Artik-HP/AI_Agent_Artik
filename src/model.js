import "dotenv/config";
// автоматически загружает .env

/**
 * Отправляет сообщения в OpenRouter.
 *
 * @param {Array<{role:string,content:string}>} messages
 * @returns {Promise<string>}
 */
export async function askModel(
  messages,
  model = "google/gemini-2.5-flash"
) {    const apiKey = process.env.OPENROUTER_API_KEY;
  // берём API-ключ

  const envModel = process.env.OPENROUTER_MODEL;
  // берём модель

  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY не найден в .env"
    );
  }

  if (!envModel) {
    throw new Error(
      "OPENROUTER_MODEL не найден в .env"
    );
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },

      body: JSON.stringify({
        model: envModel,
        messages
      })
    }
  );

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