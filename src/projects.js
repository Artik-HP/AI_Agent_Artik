import fs from "node:fs";

import {
  initDatabase,
  isDatabaseConfigured,
  dbQuery
} from "./database.js";

/**
 * @typedef {Object} ProjectTask
 * @property {string} text
 * @property {boolean} done
 */

/**
 * @typedef {Object} Project
 * @property {string} name
 * @property {string} stack
 * @property {string} status
 * @property {ProjectTask[]} tasks
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object<string, Project[]>} ProjectStore
 */

const PROJECTS_FILE = "projects.json";
const DEFAULT_STATUS = "новый";

/** @type {ProjectStore} */
let store = load();
/** @type {boolean} */
let databaseReady = false;

/**
 * @returns {ProjectStore}
 */
function load() {
  if (!fs.existsSync(PROJECTS_FILE)) {
    return {};
  }

  const raw = fs.readFileSync(PROJECTS_FILE, "utf8");

  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

function persistFile() {
  fs.writeFileSync(
    PROJECTS_FILE,
    JSON.stringify(store, null, 2),
    "utf8"
  );
}

/**
 * @param {string | number} chatId
 * @returns {string}
 */
function getKey(chatId = "default") {
  return String(chatId);
}

/**
 * @returns {Promise<boolean>}
 */
async function shouldUseDatabase() {
  if (!isDatabaseConfigured()) {
    return false;
  }

  if (!databaseReady) {
    await initDatabase();
    databaseReady = true;
  }

  return true;
}

/**
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

/**
 * @param {unknown} row
 * @returns {Project}
 */
function rowToProject(row) {
  const record = /** @type {Record<string, unknown>} */ (row);
  const rawTasks = record.tasks;

  return {
    name: String(record.name || ""),
    stack: String(record.stack || ""),
    status: String(record.status || DEFAULT_STATUS),
    tasks: Array.isArray(rawTasks) ? /** @type {ProjectTask[]} */ (rawTasks) : [],
    createdAt: String(record.created_at || record.createdAt || ""),
    updatedAt: String(record.updated_at || record.updatedAt || "")
  };
}

/**
 * @param {string | number} chatId
 * @returns {Promise<Project[]>}
 */
export async function listProjects(chatId = "default") {
  if (await shouldUseDatabase()) {
    const result = await dbQuery(
      `
        SELECT name, stack, status, tasks, created_at, updated_at
        FROM projects
        WHERE chat_id = $1
        ORDER BY created_at ASC, id ASC;
      `,
      [getKey(chatId)]
    );

    return result.rows.map(rowToProject);
  }

  const key = getKey(chatId);

  return [...(store[key] || [])];
}

/**
 * @param {string | number} chatId
 * @param {string} name
 * @returns {Promise<Project|null>}
 */
export async function getProject(chatId, name) {
  const target = normalizeName(name);

  if (!target) {
    return null;
  }

  const projects = await listProjects(chatId);

  return projects.find(project => normalizeName(project.name) === target) || null;
}

/**
 * Создаёт проект, если его ещё нет. Существующий проект не перезаписывает —
 * иначе повторное «создай проект X» стирало бы уже собранные задачи и стек.
 * @param {string | number} chatId
 * @param {string} name
 * @returns {Promise<{ created: boolean, project: Project }>}
 */
export async function createProject(chatId, name) {
  const trimmedName = String(name || "").trim();
  const existing = await getProject(chatId, trimmedName);

  if (existing) {
    return { created: false, project: existing };
  }

  const now = new Date().toISOString();

  if (await shouldUseDatabase()) {
    const result = await dbQuery(
      `
        INSERT INTO projects (chat_id, name, stack, status, tasks, created_at, updated_at)
        VALUES ($1, $2, '', $3, '[]'::jsonb, NOW(), NOW())
        RETURNING name, stack, status, tasks, created_at, updated_at;
      `,
      [getKey(chatId), trimmedName, DEFAULT_STATUS]
    );

    return { created: true, project: rowToProject(result.rows[0]) };
  }

  const key = getKey(chatId);

  if (!store[key]) {
    store[key] = [];
  }

  /** @type {Project} */
  const project = {
    name: trimmedName,
    stack: "",
    status: DEFAULT_STATUS,
    tasks: [],
    createdAt: now,
    updatedAt: now
  };

  store[key].push(project);
  persistFile();

  return { created: true, project };
}

/**
 * @param {string | number} chatId
 * @param {string} name
 * @param {(project: Project) => void} mutate меняет project на месте
 * @returns {Promise<Project|null>}
 */
async function updateProject(chatId, name, mutate) {
  const target = normalizeName(name);

  if (!target) {
    return null;
  }

  if (await shouldUseDatabase()) {
    const project = await getProject(chatId, name);

    if (!project) {
      return null;
    }

    mutate(project);

    const result = await dbQuery(
      `
        UPDATE projects
        SET stack = $3, status = $4, tasks = $5::jsonb, updated_at = NOW()
        WHERE chat_id = $1 AND LOWER(name) = LOWER($2)
        RETURNING name, stack, status, tasks, created_at, updated_at;
      `,
      [getKey(chatId), name, project.stack, project.status, JSON.stringify(project.tasks)]
    );

    return result.rowCount > 0 ? rowToProject(result.rows[0]) : null;
  }

  const key = getKey(chatId);
  const projects = store[key] || [];
  const project = projects.find(item => normalizeName(item.name) === target);

  if (!project) {
    return null;
  }

  mutate(project);
  project.updatedAt = new Date().toISOString();
  persistFile();

  return project;
}

/**
 * @param {string | number} chatId
 * @param {string} name
 * @param {string} stack
 * @returns {Promise<Project|null>}
 */
export async function setProjectStack(chatId, name, stack) {
  return updateProject(chatId, name, project => {
    project.stack = String(stack || "").trim();
  });
}

/**
 * @param {string | number} chatId
 * @param {string} name
 * @param {string} status
 * @returns {Promise<Project|null>}
 */
export async function setProjectStatus(chatId, name, status) {
  return updateProject(chatId, name, project => {
    project.status = String(status || "").trim() || DEFAULT_STATUS;
  });
}

/**
 * @param {string | number} chatId
 * @param {string} name
 * @param {string} taskText
 * @returns {Promise<Project|null>}
 */
export async function addProjectTask(chatId, name, taskText) {
  const text = String(taskText || "").trim();

  if (!text) {
    return null;
  }

  return updateProject(chatId, name, project => {
    project.tasks.push({ text, done: false });
  });
}

/**
 * Отмечает первую совпавшую по тексту незавершённую задачу выполненной.
 * @param {string | number} chatId
 * @param {string} name
 * @param {string} taskText
 * @returns {Promise<{ project: Project|null, found: boolean }>}
 */
export async function completeProjectTask(chatId, name, taskText) {
  const target = normalizeName(taskText);
  let found = false;

  const project = await updateProject(chatId, name, currentProject => {
    const task = currentProject.tasks.find(
      item => !item.done && normalizeName(item.text) === target
    );

    if (task) {
      task.done = true;
      found = true;
    }
  });

  return { project, found };
}

/**
 * @param {string | number} chatId
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function deleteProject(chatId, name) {
  const target = normalizeName(name);

  if (!target) {
    return false;
  }

  if (await shouldUseDatabase()) {
    const result = await dbQuery(
      "DELETE FROM projects WHERE chat_id = $1 AND LOWER(name) = LOWER($2);",
      [getKey(chatId), name]
    );

    return (result.rowCount ?? 0) > 0;
  }

  const key = getKey(chatId);
  const projects = store[key] || [];
  const index = projects.findIndex(item => normalizeName(item.name) === target);

  if (index === -1) {
    return false;
  }

  projects.splice(index, 1);
  store[key] = projects;
  persistFile();

  return true;
}

/**
 * Удаляет все проекты чата. Нужен тестам для изоляции от чужих данных —
 * так же, как memory.clear().
 * @param {string | number} chatId
 * @returns {Promise<boolean>}
 */
export async function clearProjects(chatId = "default") {
  if (await shouldUseDatabase()) {
    await dbQuery("DELETE FROM projects WHERE chat_id = $1;", [getKey(chatId)]);

    return true;
  }

  const key = getKey(chatId);

  store[key] = [];
  persistFile();

  return true;
}
