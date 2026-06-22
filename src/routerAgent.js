import { askModel } from "./model.js";

const DEFAULT_ROUTE = {
  tool: "none",
  input: ""
};

const ROUTER_SYSTEM_PROMPT = `
Ты роутер инструментов.

Инструменты:

Инструменты:

weather
- погода
- температура
- прогноз

youtube
- видео
- youtube
- ютуб
- ролик
- найти видео

search
- поиск информации
- статьи
- документация
- интернет поиск

Верни только JSON.

Пример:

{
  "tool":"weather",
  "input":"Луцк"
}

Если инструмент не нужен:

{
  "tool":"none",
  "input":""
}
`;

/**
 * @param {string} text
 * @returns {Promise<{tool:string,input:string}>}
 */
export async function chooseTool(text) {
  const response = await askModel([
    {
      role: "system",
      content: ROUTER_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: text
    }
  ]);

  try {
    return JSON.parse(response);
  } catch {
    return { ...DEFAULT_ROUTE };
  }
}
