import fs from "node:fs";
import path from "node:path";

function findProjectRoot(startDir = process.cwd()) {
  let currentDir = path.resolve(startDir);

  while (true) {
    if (fs.existsSync(path.join(currentDir, "package.json"))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return currentDir;
    }

    currentDir = parentDir;
  }
}

const PROJECT_ROOT = findProjectRoot();

const INCLUDE_DIRS = ["src", "test"];
const ROOT_FILES = [
  "index.js",
  "package.json",
  "README.md",
  "jsconfig.json",
  "eslint.config.js"
];

const EXCLUDED_DIRS = new Set([
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "tmp"
]);

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx"
]);

const MAX_FILE_CHARS = 8000;
const MAX_TOTAL_CHARS = 70000;

/**
 * @typedef {Object} CodeFile
 * @property {string} absolutePath
 * @property {string} relativePath
 */

/**
 * @param {string} absolutePath
 * @returns {string}
 */
function toProjectPath(absolutePath) {
  return path
    .relative(PROJECT_ROOT, absolutePath)
    .split(path.sep)
    .join("/");
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * @param {string} dir
 * @param {CodeFile[]} result
 * @returns {CodeFile[]}
 */
function collectFromDir(dir, result = []) {
  if (!fs.existsSync(dir)) {
    return result;
  }

  const entries = fs.readdirSync(dir, {
    withFileTypes: true
  });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        collectFromDir(fullPath, result);
      }

      continue;
    }

    if (entry.isFile() && isSourceFile(fullPath)) {
      result.push({
        absolutePath: fullPath,
        relativePath: toProjectPath(fullPath)
      });
    }
  }

  return result;
}

/**
 * @returns {CodeFile[]}
 */
function collectFiles() {
  const files = [];

  for (const file of ROOT_FILES) {
    const absolutePath = path.join(PROJECT_ROOT, file);

    if (fs.existsSync(absolutePath) && isSourceFile(absolutePath)) {
      files.push({
        absolutePath,
        relativePath: toProjectPath(absolutePath)
      });
    }
  }

  for (const dir of INCLUDE_DIRS) {
    collectFromDir(path.join(PROJECT_ROOT, dir), files);
  }

  return files.sort((first, second) =>
    first.relativePath.localeCompare(second.relativePath)
  );
}

/**
 * @param {CodeFile[]} files
 * @returns {string}
 */
function formatTree(files) {
  return files
    .map(file => `- ${file.relativePath}`)
    .join("\n");
}

export async function analyzeCodebase() {
  const files = collectFiles();
  const sections = [];
  const includedFiles = [];
  const truncatedFiles = [];
  let totalChars = 0;

  for (const file of files) {
    if (totalChars >= MAX_TOTAL_CHARS) {
      truncatedFiles.push(`${file.relativePath} (not included: total limit)`);
      continue;
    }

    const rawCode = fs.readFileSync(file.absolutePath, "utf8");
    const remainingChars = MAX_TOTAL_CHARS - totalChars;
    const codeLimit = Math.min(MAX_FILE_CHARS, remainingChars);
    const code = rawCode.slice(0, codeLimit);

    if (rawCode.length > code.length) {
      const reason = code.length < MAX_FILE_CHARS
        ? "total limit"
        : "file limit";

      truncatedFiles.push(`${file.relativePath} (${reason})`);
    }

    sections.push(`FILE: ${file.relativePath}

${code}

========================`);

    includedFiles.push(file.relativePath);
    totalChars += code.length;
  }

  return `CODEBASE SNAPSHOT
Root: ${PROJECT_ROOT}
Files found: ${files.length}
Files included: ${includedFiles.length}
Limits: ${MAX_FILE_CHARS} chars per file, ${MAX_TOTAL_CHARS} chars total
Truncated: ${truncatedFiles.length ? truncatedFiles.join(", ") : "no"}

FILE TREE:
${formatTree(files)}

SOURCE FILES:
${sections.join("\n\n")}`;
}
