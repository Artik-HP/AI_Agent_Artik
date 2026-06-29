import { Pool } from "pg";

/** @type {Pool | null} */
let db = null;
/** @type {Promise<boolean> | null} */
let initPromise = null;

export function isDatabaseConfigured() {
    return Boolean(process.env.DATABASE_URL?.trim());
}

/**
 * @returns {boolean | import("tls").ConnectionOptions}
 */
function getSslConfig() {
    const sslMode = String(process.env.DATABASE_SSL || "").trim().toLowerCase();

    if (["disable", "false", "0", "no"].includes(sslMode)) {
        return false;
    }

    if (["require", "true", "1", "yes"].includes(sslMode)) {
        return {
            rejectUnauthorized: false
        };
    }

    const databaseUrl = process.env.DATABASE_URL || "";
    const urlSslMode = getUrlSslMode(databaseUrl);

    if (["disable", "allow"].includes(urlSslMode)) {
        return false;
    }

    if (["prefer", "require", "verify-ca", "verify-full"].includes(urlSslMode)) {
        return {
            rejectUnauthorized: false
        };
    }

    if (
        databaseUrl.includes(".neon.tech") ||
        /[?&]sslmode=(require|verify-ca|verify-full)/i.test(databaseUrl)
    ) {
        return {
            rejectUnauthorized: false
        };
    }

    return false;
}

/**
 * @param {string} databaseUrl
 * @returns {string}
 */
function getUrlSslMode(databaseUrl) {
    try {
        return String(new URL(databaseUrl).searchParams.get("sslmode") || "")
            .trim()
            .toLowerCase();
    } catch {
        return "";
    }
}

/**
 * @param {string} databaseUrl
 * @returns {string}
 */
function getPoolConnectionString(databaseUrl) {
    try {
        const url = new URL(databaseUrl);
        url.searchParams.delete("sslmode");
        return url.toString();
    } catch {
        return databaseUrl;
    }
}

/**
 * @param {string | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function getPositiveNumber(value, fallback) {
    const number = Number(value);

    if (!Number.isFinite(number) || number <= 0) {
        return fallback;
    }

    return Math.floor(number);
}

/**
 * @returns {Pool}
 */
function getDatabasePool() {
    if (!isDatabaseConfigured()) {
        throw new Error("DATABASE_URL не указан. PostgreSQL не настроен.");
    }

    if (!db) {
        const databaseUrl = process.env.DATABASE_URL || "";
        const isNeonPooler = databaseUrl.includes("-pooler.");
        const defaultMax = isNeonPooler ? 1 : 5;

        db = new Pool({
            connectionString: getPoolConnectionString(databaseUrl),
            ssl: getSslConfig(),
            max: getPositiveNumber(process.env.DATABASE_POOL_MAX, defaultMax),
            idleTimeoutMillis: getPositiveNumber(
                process.env.DATABASE_IDLE_TIMEOUT_MS,
                30000
            ),
            connectionTimeoutMillis: getPositiveNumber(
                process.env.DATABASE_CONNECTION_TIMEOUT_MS,
                10000
            )
        });
    }

    return db;
}

/**
 * @returns {Promise<{enabled: boolean, provider: string, message: string}>}
 */
export async function getDatabaseStatus() {
    if (!isDatabaseConfigured()) {
        return {
            enabled: false,
            provider: "memory.json",
            message: "PostgreSQL не настроен. Используется memory.json."
        };
    }

    try {
        await initDatabase();

        return {
            enabled: true,
            provider: "Neon PostgreSQL",
            message: "PostgreSQL подключён. Долговременная память хранится в таблице memories."
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return {
            enabled: true,
            provider: "Neon PostgreSQL",
            message: `PostgreSQL настроен, но подключение не прошло: ${message}`
        };
    }
}

export function getDatabaseConfig() {
    return {
        enabled: isDatabaseConfigured(),
        provider: "Neon PostgreSQL",
        ssl: Boolean(getSslConfig())
    };
}

/**
 * Выполнить SQL-запрос
 * @param {string} sql
 * @param {Array<any>} params
 */
export async function dbQuery(sql, params = []) {
    return getDatabasePool().query(sql, params);
}

/**
 * Проверить подключение и создать таблицы
 */
export async function initDatabase() {
    if (!isDatabaseConfigured()) {
        console.log("⚠ DATABASE_URL не указан. Используется memory.json");
        return false;
    }

    if (initPromise) {
        return initPromise;
    }

    initPromise = (async () => {
        try {
            const pool = getDatabasePool();

            await pool.query("SELECT NOW();");

            console.log("✅ PostgreSQL подключён.");

            await pool.query(`
                CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                chat_id TEXT NOT NULL,
                role TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            `);

            await pool.query(`
                CREATE TABLE IF NOT EXISTS memories (
                id SERIAL PRIMARY KEY,
                chat_id TEXT NOT NULL,
                content TEXT NOT NULL,
                importance INTEGER DEFAULT 1,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            `);

            await pool.query(`
                ALTER TABLE memories
                ADD COLUMN IF NOT EXISTS importance INTEGER DEFAULT 1;
            `);

            await pool.query(`
                ALTER TABLE memories
                ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
            `);

            await pool.query(`
                CREATE INDEX IF NOT EXISTS memories_chat_created_idx
                ON memories (chat_id, created_at, id);
            `);

            await pool.query(`
                DO $$
                BEGIN
                    IF to_regclass('public.memory') IS NOT NULL THEN
                        INSERT INTO memories (chat_id, content, created_at)
                        SELECT old_memory.chat_id,
                               old_memory.content,
                               old_memory.created_at
                        FROM memory AS old_memory
                        WHERE NOT EXISTS (
                            SELECT 1
                            FROM memories
                            WHERE memories.chat_id = old_memory.chat_id
                              AND memories.content = old_memory.content
                              AND memories.created_at = old_memory.created_at
                        );
                    END IF;
                END $$;
            `);

            console.log("✅ Таблицы готовы.");

            return true;
        } catch (err) {
            initPromise = null;

            console.error("❌ Ошибка PostgreSQL");
            console.error(err);

            throw err;
        }
    })();

    return initPromise;
}

export async function closeDatabase() {
    if (!db) {
        return;
    }

    await db.end();
    db = null;
    initPromise = null;
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
