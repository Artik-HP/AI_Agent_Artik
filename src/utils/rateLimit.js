import { readClientIp } from "./webAuth.js";

/**
 * Простой лимитер в памяти процесса — веб-сервер здесь всегда один процесс
 * (PM2/systemd/Render запускают его в fork-режиме, без кластеризации, как и
 * sessions Map в web.js), поэтому общее состояние в памяти безопасно и не
 * требует отдельной базы данных ради лимита запросов.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** @type {Map<string, { count: number, windowStart: number }>} */
const hourlyByVisitor = new Map();

let dailyCount = 0;
let dailyWindowStart = Date.now();

/**
 * @param {string} envName
 * @param {number} fallback
 * @returns {number}
 */
function readLimit(envName, fallback) {
  const raw = Number(process.env[envName]);

  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Изредка чистит устаревшие записи, чтобы Map не рос вечно на долгоживущем
 * процессе — без этого каждый уникальный IP навсегда занимал бы память.
 * @param {number} now
 * @returns {void}
 */
function pruneStale(now) {
  for (const [key, bucket] of hourlyByVisitor) {
    if (now - bucket.windowStart > HOUR_MS) {
      hourlyByVisitor.delete(key);
    }
  }
}

/**
 * @param {import("express").Request} req
 * @returns {{ allowed: boolean, reason?: "hourly"|"daily" }}
 */
export function checkPublicRateLimit(req) {
  const now = Date.now();

  if (now - dailyWindowStart > DAY_MS) {
    dailyWindowStart = now;
    dailyCount = 0;
  }

  if (dailyCount >= readLimit("PUBLIC_RATE_LIMIT_DAILY_CAP", 300)) {
    return { allowed: false, reason: "daily" };
  }

  pruneStale(now);

  const key = readClientIp(req);
  const bucket = hourlyByVisitor.get(key);
  const hourlyLimit = readLimit("PUBLIC_RATE_LIMIT_PER_HOUR", 20);

  if (bucket && now - bucket.windowStart <= HOUR_MS) {
    if (bucket.count >= hourlyLimit) {
      return { allowed: false, reason: "hourly" };
    }

    bucket.count += 1;
  } else {
    hourlyByVisitor.set(key, { count: 1, windowStart: now });
  }

  dailyCount += 1;

  return { allowed: true };
}
