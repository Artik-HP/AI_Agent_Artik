import { Pool } from 'pg';

console.log("DATABASE_URL:");
console.log(process.env.DATABASE_URL);

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/**
 * Проверяет, настроена ли база данных.
 * @returns {boolean}
 */
export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export async function initDatabase() {
  try {
    await db.query("SELECT NOW();");

    console.log("✅ PostgreSQL подключён.");
  } catch (err) {
    console.error("❌ Ошибка подключения PostgreSQL");
    console.error(err);
  }
}

/**
 * Проверяет, указан ли DATABASE_URL.
 */

/**
 * Возвращает состояние подключения к базе.
 */
export function getDatabaseStatus() {
  return {
    configured: isDatabaseConfigured(),
    connected: !!process.env.DATABASE_URL
  };
}

export async function closeDatabase() {
    // закрываем соединение
}

export async function dbQuery(sql, params = []) {
    return db.query(sql, params);
}