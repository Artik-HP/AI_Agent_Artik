import * as basicTools from "../tools.js";
// импортируем старые инструменты: getTime, calculate

import { getWeather } from "./weather.js";
// импортируем погоду

import { searchWeb } from "../search.js";
// импортируем интернет-поиск

import { searchYouTube } from "../youtube.js";
// импортируем YouTube

export const tools = {
  time: {
    description: "Показывает текущее время",
    run: async () => basicTools.getTime()
  },

  calc: {
    description: "Считает математическое выражение",
    run: async input => String(basicTools.calculate(input))
  },

  weather: {
    description: "Показывает погоду по городу",
    run: async input => getWeather(input)
  },

  search: {
    description: "Ищет информацию в интернете",
    run: async input => searchWeb(input)
  },

  youtube: {
    description: "Ищет видео на YouTube",
    run: async input => searchYouTube(input)
  }
};

export function listTools() {
  return Object.entries(tools)
    .map(([name, tool]) => `/${name} — ${tool.description}`)
    .join("\n");
}