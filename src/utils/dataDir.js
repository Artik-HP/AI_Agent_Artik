import fs from "node:fs";
import path from "node:path";

/**
 * Корень постоянных данных (загрузки, отчёты, бэкапы, память, логи) — в
 * отличие от process.cwd(), который остаётся корнем КОДА для fileReader,
 * fileWriter, projectTree и анализа кодовой базы. На Render/VPS код
 * пересоздаётся при каждом деплое, а DATA_DIR указывает на постоянный диск,
 * который деплой не трогает. Без переменной окружения путь тот же, что и
 * раньше (process.cwd()) — поведение для локальной разработки не меняется.
 * @returns {string}
 */
export function dataRoot() {
  return path.resolve(process.env.DATA_DIR || process.cwd());
}

/**
 * @param {...string} segments
 * @returns {string}
 */
export function dataPath(...segments) {
  return path.resolve(dataRoot(), ...segments);
}

/**
 * Проверяет на старте, что DATA_DIR существует и доступен на запись — лучше
 * упасть сразу с понятной ошибкой, чем потерять загрузки/память посреди
 * работы из-за опечатки в пути или несмонтированного диска.
 * @returns {void}
 */
export function assertDataDirWritable() {
  const root = dataRoot();
  const probePath = path.join(root, ".write-check");

  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(probePath, "");
  fs.rmSync(probePath, { force: true });
}
