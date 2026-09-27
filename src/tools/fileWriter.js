import fs from "node:fs";
import path from "node:path";

const SAFE_ROOT = process.cwd();

export async function writeFileTool(input) {
  const { filePath, content } = input;

  if (!filePath || !content) {
    return "Нужно указать filePath и content.";
  }

  const fullPath = path.resolve(SAFE_ROOT, filePath);

  if (fullPath !== SAFE_ROOT && !fullPath.startsWith(SAFE_ROOT + path.sep)) {
    return "Нельзя писать файлы вне проекта.";
  }

  if (/^\.env(\..*)?$/i.test(path.basename(fullPath))) {
    return "Нельзя перезаписывать файлы с переменными окружения (.env*) — там секреты.";
  }

  fs.mkdirSync(path.dirname(fullPath), {
    recursive: true
  });

  fs.writeFileSync(fullPath, content, "utf8");

  return `Файл записан: ${filePath}`;
}

export default {
  async run(input) {
    return await writeFileTool(input);
  }
};