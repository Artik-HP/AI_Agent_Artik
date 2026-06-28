import { askModel } from "./model.js";

const DEFAULT_ROUTE = {
  tool: "none",
  input: ""
};

const ROUTER_SYSTEM_PROMPT = `
Ты роутер инструментов AI-агента.

Верни только валидный JSON без пояснений:
{
  "tool": "название_инструмента",
  "input": "строка_входа"
}

Доступные инструменты:

weather
- погода
- температура
- прогноз

youtube
- видео
- youtube
- ютуб
- ролик

codebase
- codebase analyzer
- анализ проекта
- анализ кодовой базы
- ревью проекта
- структура проекта
- найди ошибки в проекте
- архитектура проекта

search
- поиск информации
- новости
- что такое
- найти в интернете

webReader
- пользователь прислал URL и просит прочитать, открыть, разобрать,
  проанализировать или сделать конспект страницы

draw
- нарисовать картинку
- сгенерировать изображение
- создать картинку по описанию

Примеры:

Пользователь: нарисуй кота-программиста
Ответ: {"tool":"draw","input":"кота-программиста"}

Пользователь: прочитай https://nodejs.org/en
Ответ: {"tool":"webReader","input":"https://nodejs.org/en"}

Пользователь: какая погода в Луцке
Ответ: {"tool":"weather","input":"Луцк"}

Пользователь: проанализируй проект
Ответ: {"tool":"codebase","input":""}

Если инструмент не нужен:
{"tool":"none","input":""}
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
