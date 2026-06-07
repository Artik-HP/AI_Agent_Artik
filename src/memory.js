let memories = [];
// memories — массив, где будут храниться записи памяти

export function save(text) {
  // export — разрешаем использовать функцию в других файлах
  // save — сохранить запись

  memories.push(text);
  // push — добавить элемент в массив
}

export function getAll() {
  // getAll — получить все записи

  return [...memories];
  // [...] — создаём копию массива
}

export function clear() {
  // clear — очистить память

  memories = [];
}