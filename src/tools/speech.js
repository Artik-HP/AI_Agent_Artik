import "dotenv/config";

/**
 * @typedef {Object} TranscriptionResponse
 * @property {string} [text]
 * @property {{message?: string}} [error]
 */

const OPENROUTER_TRANSCRIPTIONS_URL =
  "https://openrouter.ai/api/v1/audio/transcriptions";

const DEFAULT_STT_MODEL = "openai/whisper-large-v3";

/**
 * @param {string|undefined} mimeType
 * @param {string|undefined} fileName
 * @returns {string}
 */
export function detectAudioFormat(mimeType, fileName) {
  const mime = String(mimeType || "").toLowerCase();
  const name = String(fileName || "").toLowerCase();

  if (mime.includes("mpeg") || name.endsWith(".mp3")) {
    return "mp3";
  }

  if (mime.includes("wav") || name.endsWith(".wav")) {
    return "wav";
  }

  if (mime.includes("flac") || name.endsWith(".flac")) {
    return "flac";
  }

  if (
    mime.includes("mp4") ||
    mime.includes("m4a") ||
    name.endsWith(".m4a")
  ) {
    return "m4a";
  }

  if (mime.includes("webm") || name.endsWith(".webm")) {
    return "webm";
  }

  if (mime.includes("aac") || name.endsWith(".aac")) {
    return "aac";
  }

  if (
    mime.includes("ogg") ||
    name.endsWith(".ogg") ||
    name.endsWith(".oga")
  ) {
    return "ogg";
  }

  return "ogg";
}

/**
 * @param {Buffer} audioBuffer
 * @param {{format: string, language?: string}} options
 * @returns {Promise<string>}
 */
export async function transcribeAudio(audioBuffer, options) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model =
    process.env.OPENROUTER_STT_MODEL ||
    process.env.MODEL_STT ||
    DEFAULT_STT_MODEL;

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY не найден в .env");
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    throw new Error("Аудиофайл пустой.");
  }

  const body = {
    model,
    input_audio: {
      data: audioBuffer.toString("base64"),
      format: options.format
    }
  };

  if (options.language) {
    body.language = options.language;
  }

  const response = await fetch(OPENROUTER_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  /** @type {TranscriptionResponse} */
  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      `Ошибка OpenRouter STT: ${response.status}`
    );
  }

  const text = String(data.text || "").trim();

  if (!text) {
    throw new Error("OpenRouter не вернул распознанный текст.");
  }

  return text;
}
