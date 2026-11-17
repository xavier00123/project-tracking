import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  'vendor', '__pycache__', '.idea', '.vscode', '.next', '.nuxt', 'coverage',
  '.cache', '.venv', 'venv', 'env', 'bin', 'obj', 'tmp', '.pytest_cache',
]);

const DOC_EXTS = new Set(['.md', '.markdown', '.mdx', '.rst', '.txt', '.adoc']);

const CODE_EXTS = new Map(Object.entries({
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.jsx': 'jsx', '.tsx': 'tsx',
  '.py': 'python', '.go': 'go', '.java': 'java', '.kt': 'kotlin',
  '.rb': 'ruby', '.php': 'php', '.rs': 'rust',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.swift': 'swift', '.vue': 'vue', '.scala': 'scala',
}));

const MAX_DOC_FILES = 40;
const MAX_DOC_CHARS_PER_FILE = 20_000;
const MAX_CODE_FILES = 300;
const MAX_FILE_BYTES = 512 * 1024;

function isDocFile(name) {
  return DOC_EXTS.has(path.extname(name).toLowerCase());
}

function codeLang(name) {
  return CODE_EXTS.get(path.extname(name).toLowerCase()) || null;
}

function* walk(dir, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isSymbolicLink()) continue;        // 不跟随符号链接，避免越界/死循环
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(full, depth + 1);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

/**
 * 扫描目标项目目录，分离出文档文件和代码文件。
 */
export function scanProject(rootDir) {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`目录不存在或不可读: ${root}`);
  }

  const docs = [];
  const codeFiles = [];

  for (const file of walk(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const base = path.basename(file);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;

    if (isDocFile(base) && docs.length < MAX_DOC_FILES) {
      let content = fs.readFileSync(file, 'utf8');
      if (content.length > MAX_DOC_CHARS_PER_FILE) {
        content = content.slice(0, MAX_DOC_CHARS_PER_FILE) + '\n…(已截断)';
      }
      docs.push({ path: rel, size: stat.size, content });
    } else {
      const lang = codeLang(base);
      if (lang && codeFiles.length < MAX_CODE_FILES) {
        codeFiles.push({ path: rel, lang, size: stat.size });
      }
    }
  }

  // 文档优先按深度浅、名字像 README/docs 排前面
  docs.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));

  return { root, docs, codeFiles };
}

export function readCodeFile(root, relPath, maxChars = 4000) {
  const full = path.join(root, relPath);
  if (!full.startsWith(root)) return null;
  try {
    if (fs.lstatSync(full).isSymbolicLink()) return null;
    let content = fs.readFileSync(full, 'utf8');
    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + '\n…(已截断)';
    }
    return content;
  } catch {
    return null;
  }
}
