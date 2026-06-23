import pg from "pg";

const { Pool } = pg;

let pool;

/**
 * @returns {string | undefined}
 */
export function getDatabaseUrl() {
  return process.env.DATABASE_URL?.trim();
}

/**
 * @returns {boolean}
 */
export function isDatabaseConfigured() {
  return Boolean(getDatabaseUrl());
}

/**
 * @param {string} connectionString
 * @returns {boolean | { rejectUnauthorized: boolean }}
 */
function getSslConfig(connectionString) {
  const sslMode = process.env.DATABASE_SSL?.trim().toLowerCase();

  if (sslMode === "false" || sslMode === "disable") {
    return false;
  }

  if (
    sslMode === "true" ||
    sslMode === "require" ||
    connectionString.includes("sslmode=require") ||
    connectionString.includes("neon.tech")
  ) {
    return { rejectUnauthorized: false };
  }

  return false;
}

/**
 * @returns {Pool}
 */
export function getPool() {
  const connectionString = getDatabaseUrl();

  if (!connectionString) {
    throw new Error("DATABASE_URL не задан");
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: getSslConfig(connectionString)
    });
  }

  return pool;
}

/**
 * @param {string} text
 * @param {unknown[]} [params]
 * @returns {Promise<import("pg").QueryResult>}
 */
export async function query(text, params = []) {
  return getPool().query(text, params);
}

export async function initDatabase() {
  if (!isDatabaseConfigured()) {
    return {
      enabled: false,
      message: "DATABASE_URL не задан. Используется файловая память memory.json."
    };
  }

  await query(`
    CREATE TABLE IF NOT EXISTS memories (
      id BIGSERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS memories_chat_id_created_at_idx
    ON memories (chat_id, created_at, id);
  `);

  return {
    enabled: true,
    message: "PostgreSQL подключен. Таблица memories готова."
  };
}

export async function getDatabaseStatus() {
  if (!isDatabaseConfigured()) {
    return {
      enabled: false,
      ok: true,
      message: "PostgreSQL не подключен: DATABASE_URL не задан. Используется memory.json."
    };
  }

  await query("SELECT 1;");

  return {
    enabled: true,
    ok: true,
    message: "PostgreSQL подключен и отвечает."
  };
}

export async function closeDatabase() {
  if (!pool) {
    return;
  }

  await pool.end();
  pool = undefined;
}
