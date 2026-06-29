import crypto from "node:crypto";
/**
 * Генерирует UUID v4.
 * @returns {string} UUID
 */
export function generateUuid() {
  return crypto.randomUUID();
}

/**
 * Возвращает случайное целое число в диапазоне [min, max].
 * @param {number} [min=1]
 * @param {number} [max=100]
 * @returns {number}
 */
export function randomNumber(min = 1, max = 100) {
  return Math.floor(
    Math.random() * (max - min + 1)
  ) + min;
}

/**
 * Кодирует текст в Base64.
 * @param {string} text
 * @returns {string}
 */
export function encodeBase64(text) {
  return Buffer
    .from(text, "utf8")
    .toString("base64");
}

/**
 * Возвращает текущее локальное время как строку.
 * @returns {string}
 */
export function getTime() {
  // export — разрешаем использовать функцию в других файлах
  // getTime — функция получения текущего времени

  return new Date().toLocaleString();
  // new Date() — создаёт текущую дату и время
  // toLocaleString() — превращает дату в обычный читаемый текст
}

/**
 * Регулярное выражение для проверки простых математических выражений.
 * Разрешает цифры, операторы + - * / %, скобки, точки и пробелы.
 * @type {RegExp}
 */
/** @type {RegExp} */
const MATH_EXPRESSION_PATTERN = /^[\d+\-*/%().\s]+$/;
// const — создаём переменную
// MATH_EXPRESSION_PATTERN — регулярка для проверки математического выражения
// /^[...]+$/ — разрешаем только цифры, знаки, скобки, точки и пробелы

/**
 * Результат вычисления — либо число, либо сообщение об ошибке.
 * @typedef {(number|string)} CalculateResult
 */

/**
 * Выполняет безопасное вычисление простого математического выражения.
 * @param {string|number|undefined|null} expression
 * @returns {CalculateResult}
 */
export function calculate(expression) {
  // calculate — функция калькулятора

  const normalized = String(expression || "").trim();
  // String(...) — превращаем выражение в строку
  // expression || "" — если выражения нет, берём пустую строку
  // trim() — убираем пробелы по краям

  if (!normalized) {
    return "Напиши выражение после calc. Например: calc 2 + 2";
  }

  if (!MATH_EXPRESSION_PATTERN.test(normalized)) {
    // test() — проверяет, подходит ли строка под регулярку

    return "Можно считать только простые математические выражения.";
  }

  try {
    // try — пробуем выполнить код

const result = Function(
  `"use strict"; return (${normalized});`
)();

    if (!Number.isFinite(result)) {
      // Number.isFinite() — проверяет, что результат нормальное конечное число

      return "Результат не является конечным числом.";
    }

    return result;
  } catch {
    // catch — если внутри try произошла ошибка

    return "Не смог посчитать выражение.";
  }
}

/**
 * Данные о погоде для города.
 * @typedef {Object} WeatherData
 * @property {string} city Название города
 * @property {string} condition Текущее состояние погоды
 * @property {number} temperature Температура
 * @property {string} unit Единица измерения температуры
 */

/**
 * Возвращает данные о погоде для города.
 * @param {string} city
 * @returns {WeatherData}q
 */
export function weather(city) {
  void city;
  throw new Error("Function not implemented.");
}
