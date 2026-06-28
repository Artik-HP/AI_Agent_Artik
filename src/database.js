import { Pool } from "pg";

export function isDatabaseConfigured() {
    return Boolean(process.env.DATABASE_URL);
}

export function getDatabaseStatus() {
    return {
        enabled: isDatabaseConfigured(),
        provider: "Neon PostgreSQL"
    };
}

export const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

/**
 * Выполнить SQL-запрос
 * @param {string} sql
 * @param {Array<any>} params
 */
export async function dbQuery(sql, params = []) {
    return db.query(sql, params);
}

/**
 * Проверить подключение и создать таблицы
 */
export async function initDatabase() {

    if (!isDatabaseConfigured()) {
        console.log("⚠ DATABASE_URL не указан. Используется memory.json");
        return;
    }

    try {

        await db.query("SELECT NOW();");

        console.log("✅ PostgreSQL подключён.");

        await db.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                chat_id TEXT NOT NULL,
                role TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS memory (
                id SERIAL PRIMARY KEY,
                chat_id TEXT NOT NULL,
                content TEXT NOT NULL,
                importance INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

        console.log("✅ Таблицы готовы.");

    } catch (err) {

        console.error("❌ Ошибка PostgreSQL");
        console.error(err);

    }

}

export async function closeDatabase() {
    await db.end();
    console.log("🔌 PostgreSQL отключён.");
}

/**
 * @typedef {'user' | 'assistant' | 'system'} MessageRole
 */

/**
 * @typedef {Object} Message
 * @property {number} id
 * @property {string} chat_id
 * @property {MessageRole} role
 * @property {string} text
 * @property {Date} created_at
 */

/**
 * @param {string} chatId
 * @param {MessageRole} role
 * @param {string} text
 * @returns {Promise<import('pg').QueryResult<Message>>}
 */
export async function saveMessage(chatId, role, text) {
    return dbQuery(
        `
        INSERT INTO messages (chat_id, role, text)
        VALUES ($1, $2, $3)
        `,
        [chatId, role, text]
    );
}