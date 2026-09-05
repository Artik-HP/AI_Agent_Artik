import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

/**
 * Реестр торговых точек.
 *
 * Одна и та же точка приходит боту минимум в трёх написаниях: строкой-складом
 * из выгрузки BAS («Toppers 01 Lviv Gnatuka»), кодом в имени файла («Т1 6.08-
 * 23.08.26»), листом документа перемещения («з т5», «на Т9») и просто текстом
 * запроса («с toppers 1», «на т11»). Пока сравнение шло сырыми строками,
 * запрос «перенеси с Т1» не находил ни одной строки — точка в отчёте зовётся
 * «Toppers 01 Lviv Gnatuka».
 *
 * Канонический код — «Т<номер>» / «Х<номер>» (кириллица). Всё остальное
 * приводится к нему; человекочитаемое имя из отчёта запоминается отдельно и
 * идёт в выходные файлы рядом с кодом.
 */

/**
 * @typedef {Object} PointBrand
 * @property {string} code префикс канонического кода
 * @property {string} title как сеть называется в отчётах
 * @property {RegExp} words написание сети словом
 */

/**
 * Сети. Латинские T/X держим отдельной веткой: на клавиатуре их путают с
 * кириллическими постоянно, а точки в выгрузках названы кириллицей.
 * @type {PointBrand[]}
 */
const BRANDS = [
  { code: "Т", title: "Toppers", words: /toppers|топперс|топерс/i },
  { code: "Х", title: "ХОХО", words: /хохо|xoxo|hoho/i }
];

/** Голый код точки: «т1», «T12», «х2» — буква сети вплотную к номеру. */
const BARE_CODE = /^([тtхx])\s*[-_.]?\s*(\d{1,3})$/i;

/**
 * Код точки без номера: «Т-ІНСТАГРАМ». Дефис обязателен — без него любое
 * слово на «Т» стало бы точкой.
 */
const NAMED_CODE = /^([тtхx])-([\p{L}\d]+)$/iu;

/** Латиница → кириллица для первой буквы кода. */
const LATIN_TO_CYRILLIC = { T: "Т", X: "Х" };

/** Запомненные из отчётов полные имена: «Т1» → «Toppers 01 Lviv Gnatuka». */
const learnedNames = new Map();

/** Имена из config.yaml; null — ещё не читали. */
let configNames = null;

/**
 * Ленивая загрузка секции `points` из config.yaml. Там пользователь может
 * задать своё имя точки — оно перебивает то, что написано в выгрузке.
 * @returns {Map<string, string>}
 */
function loadConfigNames() {
  if (configNames) {
    return configNames;
  }

  configNames = new Map();

  try {
    const configPath = path.resolve(process.cwd(), "config.yaml");
    const parsed = YAML.parse(fs.readFileSync(configPath, "utf8"));
    const points = parsed && parsed.points;

    if (points && typeof points === "object") {
      for (const [code, title] of Object.entries(points)) {
        const normalized = normalizePointCode(code);

        if (normalized) {
          configNames.set(normalized, String(title));
        }
      }
    }
  } catch {
    // Нет файла или он повреждён — работаем на именах из отчётов.
  }

  return configNames;
}

/**
 * Служебные слова, которые в тексте запроса стоят перед точкой и не являются
 * её частью: «со склада=Т5», «из т1», «на Т9», «з т5». Повторяются, потому что
 * предлог и существительное идут парой («со склада=Т5»).
 *
 * Границу слова пишем явным просмотром вперёд, а не `\b`: `\b` в JS считает
 * словом только ASCII, и после кириллического «на» границы не находит.
 */
const LEADING_WORDS =
  /^(?:(?:на|с|со|из|від|з|from|to|склад[ауеі]?|магазин[ауе]?|точк[аиуе]?)(?=[\s:=]|$)[\s:=]*)+/i;

/**
 * Приводит любое написание точки к каноническому коду.
 *
 * «Toppers 01 Lviv Gnatuka» → «Т1», «toppers 1» → «Т1», «t12» → «Т12»,
 * «ХОХО 02 Victoria Gardens» → «Х2», «на т9» → «Т9».
 * Точка без номера («Toppers Інстаграм») получает код по остатку строки —
 * «ТІНСТАГРАМ»: он некрасив, но стабилен и не сливается с Т1..Т12.
 * @param {unknown} raw
 * @returns {string|null} канонический код или null, если это не точка
 */
export function normalizePointCode(raw) {
  const text = String(raw ?? "").trim().replace(/\s+/g, " ");

  if (!text) {
    return null;
  }

  const cleaned = text.replace(LEADING_WORDS, "").trim();

  if (!cleaned) {
    return null;
  }

  const bare = cleaned.match(BARE_CODE);

  if (bare) {
    const letter = bare[1].toUpperCase();

    return (LATIN_TO_CYRILLIC[letter] || letter) + String(Number(bare[2]));
  }

  const named = cleaned.match(NAMED_CODE);

  if (named) {
    const letter = named[1].toUpperCase();

    return `${LATIN_TO_CYRILLIC[letter] || letter}-${named[2].toUpperCase()}`;
  }

  const brand = BRANDS.find(candidate => candidate.words.test(cleaned));

  if (!brand) {
    return null;
  }

  // Номер точки — первое число после названия сети. Именно первое: в
  // «Toppers 05 Lviv KCross» дальше могут идти цифры из адреса.
  const tail = cleaned.replace(brand.words, " ").trim();
  const number = tail.match(/\b(\d{1,3})\b/);

  if (number) {
    return brand.code + String(Number(number[1]));
  }

  const suffix = tail.replace(/[^\p{L}\d]+/gu, "").toUpperCase();

  return suffix ? `${brand.code}-${suffix}` : null;
}

/**
 * Запоминает, как точка называется в отчёте. Вызывается на каждой строке-складе
 * при чтении выгрузки: имя нужно, чтобы в готовом файле рядом с «Т1» стояло
 * «Toppers 01 Lviv Gnatuka» и кладовщик понял, о чём речь.
 * @param {unknown} raw название точки из отчёта
 * @returns {string|null} канонический код
 */
export function rememberPointName(raw) {
  const code = normalizePointCode(raw);
  const text = String(raw ?? "").trim();

  if (!code || !text) {
    return code;
  }

  // Полное имя информативнее голого кода: «Т1» перезаписывать
  // «Toppers 01 Lviv Gnatuka» не должен.
  const known = learnedNames.get(code);

  if (!known || text.length > known.length) {
    learnedNames.set(code, text);
  }

  return code;
}

/**
 * Человеческое имя точки: из config.yaml, иначе запомненное из отчёта,
 * иначе сам код.
 * @param {unknown} raw код или любое написание точки
 * @returns {string}
 */
export function pointName(raw) {
  const code = normalizePointCode(raw);

  if (!code) {
    return String(raw ?? "").trim();
  }

  return loadConfigNames().get(code) || learnedNames.get(code) || code;
}

/**
 * Две строки — про одну точку?
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function samePoint(left, right) {
  const first = normalizePointCode(left);
  const second = normalizePointCode(right);

  return Boolean(first && second && first === second);
}

/**
 * Все точки, встреченные в прочитанных отчётах. Нужен для подсказок
 * пользователю («таких складов нет, есть: Т1, Т2, …»).
 * @returns {string[]}
 */
export function knownPoints() {
  return [...new Set([...loadConfigNames().keys(), ...learnedNames.keys()])]
    .sort(comparePointCodes);
}

/**
 * Сортировка кодов по-человечески: Т1, Т2, Т10, Т12, Х1, Х2 — сеть, затем
 * номер как число, а не как текст.
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function comparePointCodes(left, right) {
  const parse = code => {
    const match = String(code || "").match(/^(\D+)(\d+)?$/);

    return match
      ? { brand: match[1], number: match[2] ? Number(match[2]) : Infinity }
      : { brand: String(code || ""), number: Infinity };
  };
  const first = parse(left);
  const second = parse(right);

  return first.brand.localeCompare(second.brand) || first.number - second.number;
}

/**
 * Ищет точку сразу за предлогом. Предлог задаётся регуляркой, дальше берутся
 * два следующих слова и проверяются от длинного к короткому: «с toppers 1» —
 * это два слова, «с т1» — одно, а «с Т5 где» — одно плюс мусор.
 * @param {string} query
 * @param {RegExp} preposition
 * @returns {string|null}
 */
function findPointAfter(query, preposition) {
  const text = String(query || "");
  const match = preposition.exec(text);

  if (!match) {
    return null;
  }

  const tokens = text
    .slice(match.index + match[0].length)
    .trim()
    .split(/[\s:=]+/)
    .slice(0, 2)
    .filter(Boolean);

  for (let take = tokens.length; take >= 1; take -= 1) {
    const code = normalizePointCode(tokens.slice(0, take).join(" "));

    if (code) {
      return code;
    }
  }

  return null;
}

/**
 * Склад-источник из текста запроса: «перенеси с Т5 …», «с toppers 1 …»,
 * «из x2 …». Без указания — null, и это нормальный режим: смотрим все точки.
 * @param {string} query
 * @returns {string|null}
 */
export function parseSourcePoint(query) {
  return findPointAfter(query, /(?:^|[\s,(])(?:со|с|из|від|з|from)(?=[\s:=])/iu);
}

/**
 * Склад-получатель из текста запроса: «… на Т9», «… в toppers 11».
 * @param {string} query
 * @returns {string|null}
 */
export function parseDestinationPoint(query) {
  return findPointAfter(query, /(?:^|[\s,(])(?:на|в|у|to)(?=[\s:=])/iu);
}

/**
 * Слова, на которых перечисление точек заканчивается: предлоги следующего
 * куска запроса и начало условия.
 */
const ENUMERATION_STOP =
  /^(?:на|в|у|to|со|с|из|з|від|from|где|де|куди|кроме|окрім|крім|except|без|период|перiод|період|дней|днів|days)$/i;

/**
 * Все точки, перечисленные после предлога: «с Т1, Т7 и Т9» → [Т1, Т7, Т9].
 *
 * Одной точки мало: развозят обычно из нескольких магазинов сразу, и раньше
 * приходилось звать бота отдельно на каждый. Перечисление кончается там, где
 * начинается слово, которое точкой не является («где», «на», «кроме»).
 * @param {string} query
 * @param {RegExp} preposition
 * @returns {string[]} канонические коды, пустой массив — не указано
 */
function findPointsAfter(query, preposition) {
  const text = String(query || "");
  const match = preposition.exec(text);

  if (!match) {
    return [];
  }

  /** @type {string[]} */
  const codes = [];
  const tokens = text
    .slice(match.index + match[0].length)
    .split(/[,;]+|\s+/)
    .map(token => token.trim())
    .filter(Boolean);
  let at = 0;

  while (at < tokens.length) {
    // Следующий предлог или служебное слово закрывает перечисление. Без этой
    // проверки «с Т1, Т7 на Т10» отдавало источниками и Т10: normalizePointCode
    // сам срезает ведущее «на», и пара «на Т10» опознавалась как точка.
    if (ENUMERATION_STOP.test(tokens[at])) {
      break;
    }

    // Соединители перечисления пропускаем молча.
    if (/^(?:и|та|and|\+|&)$/i.test(tokens[at])) {
      at += 1;
      continue;
    }

    // Сначала пара слов: «Toppers 1», «ХОХО 2» — точка называется двумя.
    const pair = normalizePointCode(tokens.slice(at, at + 2).join(" "));

    if (pair) {
      codes.push(pair);
      at += 2;
      continue;
    }

    const single = normalizePointCode(tokens[at]);

    if (single) {
      codes.push(single);
      at += 1;
      continue;
    }

    // Первое слово, которое точкой не является, закрывает перечисление:
    // «с Т1, Т7 где реализация<20%» — «где» уже не склад. Если не нашли
    // ничего за первые два слова — предлог был не про склад вовсе.
    if (codes.length > 0 || at >= 1) {
      break;
    }

    at += 1;
  }

  return [...new Set(codes)];
}

/**
 * Склады-источники: «перенеси с Т1, Т7 …». Пустой массив — любой подходящий.
 * @param {string} query
 * @returns {string[]}
 */
export function parseSourcePoints(query) {
  return findPointsAfter(query, /(?:^|[\s,(])(?:со|с|из|від|з|from)(?=[\s:=])/iu);
}

/**
 * Склады-получатели: «… на Т9 и Т10». Пустой массив — кому товар нужен.
 * @param {string} query
 * @returns {string[]}
 */
export function parseDestinationPoints(query) {
  return findPointsAfter(query, /(?:^|[\s,(])(?:на|в|у|to)(?=[\s:=])/iu);
}

/**
 * Точки, которые трогать нельзя: «кроме Т5 и Х2». Исключение сильнее любого
 * перечисления — им закрывают магазин на ремонт или инвентаризацию.
 * @param {string} query
 * @returns {string[]}
 */
export function parseExcludedPoints(query) {
  return findPointsAfter(
    query,
    /(?:^|[\s,(])(?:кроме|окрім|крім|except|без)(?=[\s:=])/iu
  );
}

/**
 * Забывает выученные имена. Только для тестов: реестр — модульный синглтон,
 * и без сброса один тест видел бы точки из другого.
 * @returns {void}
 */
export function resetPointRegistry() {
  learnedNames.clear();
  configNames = null;
}
