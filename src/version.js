import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Какой именно код сейчас работает.
 *
 * Нужно потому, что бота легко запустить дважды — pm2 держит одну копию,
 * человек руками стартует вторую, и Telegram отдаёт сообщения то одной, то
 * другой (в логах это видно как «409: Conflict»). Со стороны это выглядит как
 * плавающая ошибка в отчётах: одна и та же кнопка отвечает по-разному.
 * Отметка версии в /stats и в стартовом логе отвечает на вопрос «чей это был
 * ответ» одним сообщением боту, без раскопок в процессах.
 */

/** Каталог проекта: файл лежит в src/, значит корень — уровнем выше. */
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/** @type {string|null} */
let cached = null;

/**
 * Короткий хеш текущего коммита. Git может быть недоступен (запуск из копии
 * без .git, урезанный образ) — тогда версию покажем по времени файла.
 * @returns {string|null}
 */
function readCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Время последней правки рабочего кода. Именно оно ловит случай «процесс
 * запущен вчера, а файлы правили сегодня»: коммит при этом не меняется.
 * @returns {string|null}
 */
function readNewestSourceTime() {
  /** @type {number} */
  let newest = 0;

  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full);
        continue;
      }

      if (entry.name.endsWith(".js")) {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      }
    }
  };

  try {
    walk(path.join(PROJECT_ROOT, "src"));
  } catch {
    return null;
  }

  return newest > 0
    ? new Date(newest).toISOString().slice(0, 16).replace("T", " ")
    : null;
}

/**
 * Строка вида «2b707d3, файлы от 2026-09-05 08:41, запущен 09:35». Считается
 * один раз за процесс: она описывает код, с которым процесс стартовал, а не
 * то, что лежит на диске сейчас.
 * @returns {string}
 */
export function describeRunningCode() {
  if (cached) {
    return cached;
  }

  const started = new Date()
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
  const parts = [
    readCommit(),
    readNewestSourceTime() && `файлы от ${readNewestSourceTime()}`,
    `запущен ${started}`
  ].filter(Boolean);

  cached = parts.join(", ");

  return cached;
}

export default { describeRunningCode };
