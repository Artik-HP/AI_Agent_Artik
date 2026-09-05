import fs from "node:fs";
import path from "node:path";

/**
 * Файловый лог. Бот живёт в терминале, а терминал закрывают — вместе со всей
 * историей падения. После «перестал отвечать» смотреть было решительно некуда,
 * поэтому всё важное дублируем в `logs/bot.log`.
 */

const LOG_DIR = "logs";
const LOG_FILE = "bot.log";

/** Больше этого файл не растёт: при превышении старый уезжает в .1. */
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * @returns {string}
 */
function logPath() {
  return path.resolve(process.cwd(), LOG_DIR, LOG_FILE);
}

/**
 * Один разворот файла, без архива истории: нужен свежий хвост, а не летопись.
 * @param {string} file
 * @returns {void}
 */
function rotateIfNeeded(file) {
  try {
    if (fs.statSync(file).size < MAX_SIZE_BYTES) {
      return;
    }

    fs.rmSync(`${file}.1`, { force: true });
    fs.renameSync(file, `${file}.1`);
  } catch {
    // Файла ещё нет или он занят — не повод падать.
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Пишет строку в консоль и в файл. Сам никогда не бросает: логгер, роняющий
 * процесс, — худший вид логгера.
 * @param {"info"|"error"} level
 * @param {...unknown} parts
 * @returns {void}
 */
export function log(level, ...parts) {
  const line = `${new Date().toISOString()} [${level}] ${parts.map(describe).join(" ")}`;

  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }

  try {
    const file = logPath();

    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file);
    fs.appendFileSync(file, `${line}\n`, "utf8");
  } catch {
    // Диск занят или нет прав — консоль уже отработала.
  }
}

/**
 * @param {...unknown} parts
 * @returns {void}
 */
export function logInfo(...parts) {
  log("info", ...parts);
}

/**
 * @param {...unknown} parts
 * @returns {void}
 */
export function logError(...parts) {
  log("error", ...parts);
}

/**
 * Ловит то, что не поймал никто: необработанные reject-ы и исключения.
 * В Node 24 необработанный reject по умолчанию убивает процесс — бот исчезал
 * молча, без единой строки в консоли.
 *
 * Reject переживаем: цена — один несостоявшийся ответ. Исключение — нет:
 * после него состояние процесса не гарантировано, честнее выйти с ненулевым
 * кодом, чтобы супервизор (pm2/nodemon) поднял заново.
 * @returns {void}
 */
export function installCrashHandlers() {
  process.on("unhandledRejection", reason => {
    logError("Необработанный reject (бот продолжает работу):", reason);
  });

  process.on("uncaughtException", error => {
    logError("Необработанное исключение, выходим:", error);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 200).unref();
  });
}
