import "dotenv/config";

export async function askModel(messages) {
const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_MODEL;

if (!apiKey) {
      throw new Error("Нет OPENROUTER_API_KEY в .env");
    }

    if (!model) {
      throw new Error("Нет OPENROUTER_MODEL в .env");
    }

const response = await fetch(
  "https://openrouter.ai/api/v1/chat/completions",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages
    })
  }
);

      const data = await response.json();

if (!response.ok) {
    throw new Error(
        data.error?.message ||
        `Ошибка API: ${response.status} ${response.statusText}`
    );
}
        
return data.choices[0].message.content;
}