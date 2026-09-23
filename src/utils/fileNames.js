/**
 * Приводит имя файла к безопасному виду. Кроме символов, запрещённых в путях
 * (`<>:"/\|?*`), убираем `,` и `;` — дальше по коду extractSpreadsheetPaths
 * трактует их как разделители списка файлов, и запятая в имени превращается
 * в ложный путь вида «_хвост_после_запятой.xlsx». Общее для Telegram и
 * веб-загрузок — оба сохраняют присланный файл под этим именем на диск.
 * @param {string} value
 * @returns {string}
 */
export function sanitizeFileName(value) {
  return String(value || "table.xlsx")
    .replace(/[<>:"/\\|?*,;]/g, "_")
    .split("")
    .filter(char => char.charCodeAt(0) >= 32)
    .join("")
    .slice(0, 120);
}
