import { askModel } from "./model.js";

export async function chooseTool(text) {
  const response = await askModel([
    {
      role: "system",
      content: `
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
`
    },
    {
      role: "user",
      content: text
    }
  ]);

  try {
    return JSON.parse(response);
  } catch {
    return {
      tool: "none",
      input: ""
    };
  }
}