import * as basicTools from "../tools.js";
// импортируем старые инструменты: getTime, calculate

import { getWeather } from "./weather.js";
// импортируем погоду

import { searchWeb } from "./search.js";
// импортируем интернет-поиск
import fileReader from "./fileReader.js";
import { searchYouTube } from "./youtube.js";
// импортируем YouTube
import { analyzeCodebase } from "./codeAnalyzer.js";
import webReader from "./webReader.js";
/**
 * @typedef {Object} Tool
 * @property {string} description
 * @property {(input?: string) => Promise<unknown>} run
 */

/**
 * @typedef {Object.<string, Tool>} ToolsMap
 */

/** @type {ToolsMap} */
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
    run: async input => getWeather(input ?? "")
  },

uuid: {
  description: "Генерирует UUID",
  run: async () => basicTools.generateUuid()
},

random: {
  description: "Случайное число от 1 до 100",
  run: async () => String(basicTools.randomNumber())
},

base64: {
  description: "Кодирует текст в Base64",
  run: async input => basicTools.encodeBase64(input ?? "")
},

  search: {
    description: "Ищет информацию в интернете",
    run: async input => searchWeb(input ?? "")
  },

webReader: {
  description: "Читает содержимое веб-страницы",
  run: async input => webReader.run(input ?? "")
},

youtube: {
  description: "Ищет видео на YouTube",
  run: async input => searchYouTube(input ?? "")
},

fileReader: {
  description: "Читает файл проекта",
  run: async input => fileReader.run(input ?? "")
},

codebase: {
  description: "Читает и анализирует код проекта",
  run: async () => analyzeCodebase()
},
};

export function listTools() {
  return Object.entries(tools)
    .map(([name, tool]) => `/${name} — ${tool.description}`)
    .join("\n")};
