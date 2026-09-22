import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { askModelForImage } from "../model.js";

/** Каталог, куда сохраняются сгенерированные и отредактированные картинки. */
const OUTPUT_DIR = "exports";

/**
 * @typedef {Object} ImageResult
 * @property {boolean} ok
 * @property {string} prompt
 * @property {string} [filePath]
 * @property {string} [message]
 */

/**
 * @param {string|undefined} input
 * @returns {string}
 */
export function normalizeImagePrompt(input) {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

/**
 * @param {Date} [date]
 * @returns {string}
 */
function createTimestamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
}

/**
 * Достаёт первую картинку из ответа модели и сохраняет её в exports/.
 * OpenRouter отдаёт картинку как data-URL (`data:image/png;base64,...`) в
 * message.images — не готовый файл и не постоянная ссылка, поэтому её нужно
 * декодировать и сохранить самим, иначе следующий шаг (отправка в Telegram,
 * повторное редактирование) нечего будет прочитать.
 * @param {import("../model.js").ImageResponseMessage} message
 * @param {string} filePrefix
 * @returns {string}
 */
function saveFirstImage(message, filePrefix) {
  const dataUrl = message.images?.[0]?.image_url?.url || "";
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);

  if (!match) {
    throw new Error("Модель не вернула картинку.");
  }

  const [, extension, base64Data] = match;
  const fileName = `${filePrefix}-${createTimestamp()}-${randomUUID()}.${extension}`;
  const filePath = path.join(OUTPUT_DIR, fileName);

  fs.mkdirSync(OUTPUT_DIR, {
    recursive: true
  });
  fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"), { flag: "wx" });

  return filePath;
}

/**
 * Рисует картинку с нуля по текстовому описанию.
 * @param {string|undefined} input
 * @returns {Promise<ImageResult>}
 */
export async function drawImage(input) {
  const prompt = normalizeImagePrompt(input);

  if (!prompt) {
    return {
      ok: false,
      prompt: "",
      message: "Напиши описание картинки. Например: /draw кот-программист в космосе"
    };
  }

  const message = await askModelForImage([
    {
      role: "user",
      content: prompt
    }
  ]);

  return {
    ok: true,
    prompt,
    filePath: saveFirstImage(message, "image")
  };
}

/**
 * Редактирует уже готовую картинку по текстовой инструкции — отправляет её
 * модели вместе с описанием изменений и сохраняет результат как новый файл
 * (исходный не трогаем, как и остальные экспорты проекта). Источник картинки
 * — просто буфер байт, поэтому вызывающая сторона сама решает, откуда его
 * взять: файл из exports/ (последняя нарисованная ботом картинка) или
 * скачанное фото из Telegram (любая картинка, на которую ответил человек).
 * @param {string|undefined} instruction
 * @param {Buffer|undefined} imageBuffer
 * @param {string} [mimeType]
 * @returns {Promise<ImageResult>}
 */
export async function editImage(instruction, imageBuffer, mimeType = "image/png") {
  const prompt = normalizeImagePrompt(instruction);

  if (!prompt) {
    return {
      ok: false,
      prompt: "",
      message: "Напиши, что изменить. Например: измени картинку: добавь закат"
    };
  }

  if (!imageBuffer || imageBuffer.length === 0) {
    return {
      ok: false,
      prompt,
      message: "Сначала нарисуй картинку — редактировать пока нечего."
    };
  }

  const base64Source = imageBuffer.toString("base64");

  const message = await askModelForImage([
    {
      role: "user",
      content: [
        {
          type: "text",
          text: prompt
        },
        {
          type: "image_url",
          image_url: {
            url: `data:${mimeType};base64,${base64Source}`
          }
        }
      ]
    }
  ]);

  return {
    ok: true,
    prompt,
    filePath: saveFirstImage(message, "image-edit")
  };
}

/**
 * @param {ImageResult} result
 * @returns {string}
 */
export function formatImageResult(result) {
  if (!result.ok) {
    return result.message || "Не получилось подготовить картинку.";
  }

  return [
    "Картинка-файл:",
    result.filePath,
    "",
    `Промпт: ${result.prompt}`,
    "",
    "Изменить: «измени картинку: ...», /editimage ... или ответь на фото текстом."
  ].join("\n");
}

export default {
  run: async input => formatImageResult(
    await drawImage(input)
  )
};
