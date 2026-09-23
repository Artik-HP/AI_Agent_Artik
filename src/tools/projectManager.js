import {
  addProjectTask,
  completeProjectTask,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  setProjectStack,
  setProjectStatus
} from "../projects.js";

const HELP_TEXT = [
  "📁 Менеджер проектов — запоминает твои проекты между сессиями.",
  "",
  "/projects — список всех проектов",
  "создай проект <название> — завести новый проект",
  "проект <название> — показать детали",
  "проект <название> стек: React, Node.js — задать стек",
  "проект <название> статус: в разработке — задать статус",
  "проект <название> задача: сделать оплату — добавить задачу",
  "проект <название> готово: сделать оплату — отметить задачу выполненной",
  "удали проект <название> — удалить проект"
].join("\n");

const FIELD_PATTERN = /^(.*?)\s+(стек|статус|задача|готово)\s*[:=]\s*(.+)$/isu;

/**
 * @param {string} lower
 * @param {string} original
 * @param {string[]} keywords
 * @returns {string|null} остаток исходной строки после первого совпавшего
 *   ключевого слова, с сохранением регистра
 */
function extractAfter(lower, original, keywords) {
  for (const keyword of keywords) {
    const index = lower.indexOf(keyword);

    if (index !== -1) {
      return original.slice(index + keyword.length).trim();
    }
  }

  return null;
}

/**
 * @param {import("../projects.js").Project} project
 * @returns {string}
 */
function formatProjectCard(project) {
  const lines = [
    `📁 ${project.name}`,
    `Статус: ${project.status}`,
    `Стек: ${project.stack || "не задан"}`
  ];

  if (project.tasks.length === 0) {
    lines.push("Задачи: пока нет");
  } else {
    lines.push("Задачи:");
    lines.push(
      ...project.tasks.map(task => `  ${task.done ? "✅" : "◻️"} ${task.text}`)
    );
  }

  return lines.join("\n");
}

/**
 * @param {import("../projects.js").Project[]} projects
 * @returns {string}
 */
function formatProjectList(projects) {
  if (projects.length === 0) {
    return "Пока нет ни одного проекта. Создай его: «создай проект <название>».";
  }

  return [
    `📁 Проекты (${projects.length}):`,
    ...projects.map(project => {
      const total = project.tasks.length;
      const done = project.tasks.filter(task => task.done).length;
      const progress = total > 0 ? ` (${done}/${total} задач)` : "";

      return `• ${project.name} — ${project.status}${progress}`;
    })
  ].join("\n");
}

/**
 * @param {unknown} input
 * @returns {{ query: string, chatId: string }}
 */
function normalizeInput(input) {
  if (typeof input === "string") {
    return { query: input, chatId: "default" };
  }

  if (input && typeof input === "object") {
    const record = /** @type {Record<string, unknown>} */ (input);

    return {
      query: String(record.query || ""),
      chatId: record.chatId ? String(record.chatId) : "default"
    };
  }

  return { query: "", chatId: "default" };
}

/**
 * @param {unknown} input
 * @returns {Promise<string>}
 */
async function run(input) {
  const { query, chatId } = normalizeInput(input);
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();

  if (!trimmed || lower === "/project" || lower === "проект") {
    return HELP_TEXT;
  }

  if (
    lower === "/projects" ||
    lower.startsWith("/projects") ||
    lower.includes("покажи проекты") ||
    lower.includes("мои проекты") ||
    lower.includes("список проектов") ||
    lower.includes("все проекты")
  ) {
    return formatProjectList(await listProjects(chatId));
  }

  const createTarget = extractAfter(lower, trimmed, [
    "создай проект ",
    "создать проект ",
    "новый проект ",
    "/project создай "
  ]);

  if (createTarget !== null) {
    if (!createTarget) {
      return "Напиши название проекта: «создай проект Telegram Shop Bot».";
    }

    const { created, project } = await createProject(chatId, createTarget);

    return created
      ? `Проект «${project.name}» создан. Статус: ${project.status}.`
      : `Проект «${project.name}» уже есть.\n\n${formatProjectCard(project)}`;
  }

  const deleteTarget = extractAfter(lower, trimmed, [
    "удали проект ",
    "удалить проект "
  ]);

  if (deleteTarget !== null) {
    if (!deleteTarget) {
      return "Напиши, какой проект удалить: «удали проект Telegram Shop Bot».";
    }

    const removed = await deleteProject(chatId, deleteTarget);

    return removed
      ? `Проект «${deleteTarget}» удалён.`
      : `Не нашёл проект «${deleteTarget}».`;
  }

  const projectTarget = extractAfter(lower, trimmed, [
    "/project ",
    "проект "
  ]);

  if (projectTarget === null) {
    return HELP_TEXT;
  }

  const fieldMatch = projectTarget.match(FIELD_PATTERN);

  if (!fieldMatch) {
    const project = await getProject(chatId, projectTarget);

    return project
      ? formatProjectCard(project)
      : `Не нашёл проект «${projectTarget}». Список: /projects`;
  }

  const [, name, field, value] = fieldMatch;
  const fieldLower = field.toLowerCase();

  if (!(await getProject(chatId, name))) {
    return `Не нашёл проект «${name.trim()}». Список: /projects`;
  }

  if (fieldLower === "стек") {
    const project = await setProjectStack(chatId, name, value);

    return `Стек проекта «${project.name}» обновлён: ${project.stack}`;
  }

  if (fieldLower === "статус") {
    const project = await setProjectStatus(chatId, name, value);

    return `Статус проекта «${project.name}»: ${project.status}`;
  }

  if (fieldLower === "задача") {
    const project = await addProjectTask(chatId, name, value);

    return `Задача добавлена в «${project.name}»: ${value.trim()}`;
  }

  // fieldLower === "готово"
  const { project, found } = await completeProjectTask(chatId, name, value);

  if (!found || !project) {
    return `Не нашёл незавершённую задачу «${value.trim()}» в проекте «${name.trim()}».`;
  }

  return `Задача выполнена в «${project.name}»: ${value.trim()}`;
}

export default { run };
