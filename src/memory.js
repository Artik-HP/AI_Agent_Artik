import fs from "node:fs";
// fs — встроенный модуль Node.js для работы с файлами

const MEMORY_FILE = "memory.json";
// файл, где хранится память

let memories = load();
// при запуске загружаем память из файла

function load() {
  // load — загрузить память

  if (!fs.existsSync(MEMORY_FILE)) {
    // если файла нет

    return [];
    // возвращаем пустую память
  }

  const raw = fs.readFileSync(MEMORY_FILE, "utf8");
  // читаем файл как текст

  if (!raw.trim()) {
    // если файл пустой

    return [];
  }

  return JSON.parse(raw);
  // превращаем JSON-текст в массив
}

function persist() {
  // persist — сохранить память

  fs.writeFileSync(
    MEMORY_FILE,
    JSON.stringify(memories, null, 2),
    "utf8"
  );
}

export function save(text) {
  // save — сохранить запись

  memories.push(text);
  persist();

  return true;
}

export function getAll() {
  // getAll — получить всю память

  return [...memories];
}

export function clear() {
  // clear — очистить память

  memories = [];
  persist();

  return true;
}

export function remove(index) {
  // remove — удалить запись по номеру массива

  if (index < 0 || index >= memories.length) {
    return false;
  }

  memories.splice(index, 1);
  persist();

  return true;
}

export function removeByText(text) {
  // removeByText — удалить запись по тексту

  const normalizedText = String(text || "").trim().toLowerCase();
  // нормализуем текст: строка, без пробелов, нижний регистр

  if (!normalizedText) {
    return false;
  }

  const index = memories.findIndex(
    item => String(item).trim().toLowerCase() === normalizedText
  );
  // findIndex — ищет номер записи

  if (index === -1) {
    return false;
  }

  memories.splice(index, 1);
  persist();

  return true;
}