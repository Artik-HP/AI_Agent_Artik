const DEFAULT_IMAGE_MODEL = "flux";
const DEFAULT_IMAGE_WIDTH = 1024;
const DEFAULT_IMAGE_HEIGHT = 1024;
const MIN_IMAGE_SIZE = 256;
const MAX_IMAGE_SIZE = 2048;

/**
 * @typedef {Object} ImageResult
 * @property {boolean} ok
 * @property {string} prompt
 * @property {string} [url]
 * @property {string} [message]
 */

/**
 * @param {string|undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function readImageSize(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(
    MAX_IMAGE_SIZE,
    Math.max(MIN_IMAGE_SIZE, parsed)
  );
}

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
 * @param {string} prompt
 * @returns {string}
 */
export function buildImageUrl(prompt) {
  const width = readImageSize(
    process.env.IMAGE_WIDTH,
    DEFAULT_IMAGE_WIDTH
  );
  const height = readImageSize(
    process.env.IMAGE_HEIGHT,
    DEFAULT_IMAGE_HEIGHT
  );
  const model =
    process.env.IMAGE_MODEL ||
    DEFAULT_IMAGE_MODEL;

  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    model,
    nologo: "true"
  });

  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
}

/**
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

  return {
    ok: true,
    prompt,
    url: buildImageUrl(prompt)
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
    "Картинка готова:",
    result.url,
    "",
    `Промпт: ${result.prompt}`
  ].join("\n");
}

export default {
  run: async input => formatImageResult(
    await drawImage(input)
  )
};
