function getTime() {
  return new Date().toLocaleString();
}

const MATH_EXPRESSION_PATTERN = /^[\d+\-*/%().\s]+$/;

function calculate(expression) {
  const normalized = String(expression || "").trim();

  if (!normalized) {
    return "Напиши выражение после calc. Например: calc 2 + 2";
  }

  if (!MATH_EXPRESSION_PATTERN.test(normalized)) {
    return "Можно считать только простые математические выражения.";
  }

  try {
    const result = Function("\"use strict\"; return (" + normalized + ");")();

    if (!Number.isFinite(result)) {
      return "Результат не является конечным числом.";
    }

    return result;
  } catch {
    return "Не смог посчитать выражение.";
  }
}

module.exports = {
  getTime,
  calculate
};
