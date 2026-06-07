import fs from "node:fs";
// fs — модуль Node.js для работы с файлами

const MEMORY_FILE = "memory.json";
// имя файла, где будет храниться память

let memories = load();
// при запуске программы сразу загружаем память из файла

function load() {
  // load — загрузить память из файла

  if (!fs.existsSync(MEMORY_FILE)) {
    // если файла memory.json ещё нет

    return [];
    // возвращаем пустой массив
  }

  const raw = fs.readFileSync(MEMORY_FILE, "utf8");
  // читаем файл как текст

  return JSON.parse(raw);
  // превращаем JSON-текст обратно в массив
}

function persist() {
  // persist — сохранить память на диск

  fs.writeFileSync(
    MEMORY_FILE,
    JSON.stringify(memories, null, 2),
    "utf8"
  );
  // JSON.stringify — превращает массив в красивый JSON
}

export function save(text) {
  memories.push(text);
  // добавляем запись в память

  persist();
  // сразу сохраняем в memory.json
}

export function getAll() {
  return [...memories];
  // возвращаем копию памяти
}

export function clear() {
  memories = [];
  // очищаем массив

  persist();
  // сохраняем пустую память в файл
}