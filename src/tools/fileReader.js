import fs from "node:fs";
import path from "node:path";

/** @type {string} */
const SAFE_ROOT = process.cwd();

/**
 * @typedef {Object} FileReaderResult
 * @property {string} result - Result message or file content
 */

/**
 * @typedef {Object} FileReaderTool
 * @property {(input: string) => Promise<string>} run
 */

/**
 * Read file from project safe root.
 * @param {string} filePath - Path to the file to read
 * @returns {Promise<string>} File content or error message
 */
export async function readFileTool(filePath) {
  const normalizedPath = String(filePath || "").trim();

  if (!normalizedPath) {
    return "Укажи путь к файлу. Например: прочитай файл package.json";
  }

  const fullPath = path.resolve(SAFE_ROOT, normalizedPath);

  if (!fullPath.startsWith(SAFE_ROOT)) {
    return "Нельзя читать файлы вне проекта.";
  }

  if (!fs.existsSync(fullPath)) {
    return `Файл не найден: ${normalizedPath}`;
  }

  const stat = fs.statSync(fullPath);

  if (stat.isDirectory()) {
    return "Это папка, а не файл.";
  }

  const content = fs.readFileSync(fullPath, "utf8");

  return [
    `Файл: ${normalizedPath}`,
    "",
    content.slice(0, 15000)
  ].join("\n");
}

/** @type {FileReaderTool} */
export default {
  /**
   * @param {string} input
   * @returns {Promise<string>}
   */
  async run(input) {
    return await readFileTool(input);
  }
};