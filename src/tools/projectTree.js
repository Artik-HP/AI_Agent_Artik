import fs from "node:fs";
import path from "node:path";

const IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".env",
  "package-lock.json",
  "pnpm-lock.yaml"
]);

function buildTree(dir, prefix = "") {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(entry => !IGNORE.has(entry.name));

  let result = "";

  entries.forEach((entry, index) => {
    const isLast = index === entries.length - 1;
    const pointer = isLast ? "└─ " : "├─ ";
    const fullPath = path.join(dir, entry.name);

    result += `${prefix}${pointer}${entry.name}\n`;

    if (entry.isDirectory()) {
      const nextPrefix = prefix + (isLast ? "   " : "│  ");
      result += buildTree(fullPath, nextPrefix);
    }
  });

  return result;
}

export default {
  async run(input = ".") {
    const root = process.cwd();
    const target = path.resolve(root, input || ".");

    if (!target.startsWith(root)) {
      return "Нельзя смотреть папки вне проекта.";
    }

    if (!fs.existsSync(target)) {
      return `Папка не найдена: ${input}`;
    }

    return `Структура проекта:\n\n${buildTree(target)}`;
  }
};