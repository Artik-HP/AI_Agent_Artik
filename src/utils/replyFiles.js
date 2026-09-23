import fs from "node:fs";
import path from "node:path";

/**
 * Картинку рисует OpenRouter и отдаёт её как base64 — drawImage.js decode-ит
 * и сохраняет файл в exports/, а сюда прилетает готовый путь сентинел-строкой
 * "Картинка-файл:". Общее для Telegram и веб-интерфейса: оба должны достать
 * из текстового ответа агента путь к файлу, который нужно прикрепить.
 * @param {string} answer
 * @returns {{filePath: string, caption: string}|null}
 */
export function getImageReply(answer) {
  const match = answer.match(/^Картинка-файл:\n(.+)$/m);

  if (!match) {
    return null;
  }

  const filePath = path.resolve(String(match[1]).trim());

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return {
    filePath,
    caption: answer
      .replace(/^Картинка-файл:\n.+$/m, "Картинка готова.")
      .slice(0, 1000)
  };
}

/**
 * Excel-инструменты отдают готовый файл той же сентинел-строкой
 * ("Excel-файл:") — см. getImageReply.
 * @param {string} answer
 * @returns {{filePath: string, fileName: string, caption: string}|null}
 */
export function getDocumentReply(answer) {
  const match = answer.match(/^Excel-файл:\s*(.+\.xlsx)\s*$/m);

  if (!match) {
    return null;
  }

  const filePath = path.resolve(String(match[1]).trim());

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return {
    filePath,
    fileName: path.basename(filePath),
    caption: answer
      .replace(/^Excel-файл:\s*.+\.xlsx\s*$/m, "Excel-файл прикреплён.")
      .slice(0, 1000)
  };
}
