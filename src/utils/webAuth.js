/**
 * Общий секрет между этим сервером и прокси портфолио (Next.js route
 * handler). Обычный посетитель веб-страницы его не знает и не может
 * прислать — секрет известен только двум серверам, никогда не браузеру.
 */
const AGENT_KEY_HEADER = "x-agent-key";

/** Id сессии, который прокси заводит сам и прокидывает вместо cookie. */
const SESSION_ID_HEADER = "x-session-id";

/** Реальный IP посетителя — прокси достаёт его из своего входящего запроса. */
const CLIENT_IP_HEADER = "x-client-ip";

/**
 * Тот же формат, что и у cookie artik_sid (crypto.randomUUID() или похожая
 * строка) — без него sessionId из заголовка мог бы содержать "../" и
 * вырваться за пределы UPLOAD_ROOT через path.join, который сам по себе
 * traversal не останавливает.
 */
const SAFE_ID_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;

/**
 * Требует X-Agent-Key на защищённых маршрутах. Без настроенного
 * WEB_SHARED_SECRET маршрут отвечает 503, а не пропускает запрос молча —
 * лучше явно нерабочий веб-чат, чем незаметно беззащитный.
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @returns {void}
 */
export function requireAgentKey(req, res, next) {
  const expected = String(process.env.WEB_SHARED_SECRET || "").trim();

  if (!expected) {
    res.status(503).json({
      error: "Веб-интерфейс не настроен: не задан WEB_SHARED_SECRET."
    });
    return;
  }

  const provided = String(req.headers[AGENT_KEY_HEADER] || "");

  if (provided !== expected) {
    res.status(401).json({ error: "Нет доступа." });
    return;
  }

  next();
}

/**
 * @param {import("express").Request} req
 * @returns {string|null}
 */
export function readTrustedSessionId(req) {
  const value = String(req.headers[SESSION_ID_HEADER] || "").trim();

  return SAFE_ID_PATTERN.test(value) ? value : null;
}

/**
 * @param {import("express").Request} req
 * @returns {string}
 */
export function readClientIp(req) {
  const forwarded = String(req.headers[CLIENT_IP_HEADER] || "").trim();

  return forwarded || req.ip || "unknown";
}
