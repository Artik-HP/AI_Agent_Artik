import fs from "node:fs";
import path from "node:path";

const SAFE_ROOT = process.cwd();

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

export default {
  async run(input) {
    return await readFileTool(input);
  }
};