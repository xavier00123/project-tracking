import fs from 'node:fs';
import path from 'node:path';
import { readCodeFile } from './scanner.js';

// 针对常见语言的正则符号提取
const SYMBOL_PATTERNS = [
  // 路由定义 (express/koa/flask/gin 等)
  { re: /(?:router|app|route)\s*\.\s*(get|post|put|delete|patch|use)\s*\(\s*['"`]([^'"`]+)['"`]/gi, fmt: m => `route ${m[1].toUpperCase()} ${m[2]}` },
  { re: /@(?:app|bp|router)\s*\.\s*(get|post|put|delete|patch|route)\s*\(\s*['"`]([^'"`]+)['"`]/gi, fmt: m => `route ${m[1].toUpperCase()} ${m[2]}` },
  // function / class
  { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, fmt: m => `fn ${m[1]}` },
  { re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm, fmt: m => `class ${m[1]}` },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm, fmt: m => `fn ${m[1]}` },
  { re: /^\s*(?:export\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm, fmt: m => `def ${m[1]}` },
  { re: /^\s*(?:export\s+)?(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm, fmt: m => `def ${m[1]}` },
  { re: /^\s*class\s+([A-Za-z_][\w]*)/gm, fmt: m => `class ${m[1]}` },
  { re: /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)\s*\(/gm, fmt: m => `func ${m[1]}` },
  { re: /^\s*(?:public|private|protected|static|final|synchronized|async|\s)*\s*(?:[\w<>\[\],.?]+\s+)+([a-zA-Z_][\w]*)\s*\([^;]*\)\s*[{;]/gm, fmt: m => `method ${m[1]}` },
  { re: /^\s*(?:export\s+)?(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/gm, fmt: m => `fn ${m[1]}` },
];

const MAX_SYMBOLS_PER_FILE = 30;

function extractSymbols(content) {
  const symbols = new Set();
  for (const { re, fmt } of SYMBOL_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) && symbols.size < MAX_SYMBOLS_PER_FILE) {
      symbols.add(fmt(m));
    }
  }
  return [...symbols];
}

/**
 * 构建代码索引：每个代码文件的符号列表。
 * 返回紧凑的索引，供 LLM 判断功能实现情况。
 */
export function buildCodeIndex(root, codeFiles) {
  const index = [];
  for (const f of codeFiles) {
    const full = path.join(root, f.path);
    let content;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const symbols = extractSymbols(content);
    index.push({ path: f.path, lang: f.lang, symbols, content });
  }
  return index;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'is',
  '的', '了', '和', '与', '对', '为', '在', '是', '功能', '支持', '实现', '提供',
  '可以', '用户', '系统', '进行', '通过', '以及', '等', '页面', '管理',
]);

export function keywordsOf(text) {
  const words = text
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .split(/\s+/)
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length >= 2 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

/**
 * 用关键词在代码索引中找候选文件（用于给 LLM 提供证据上下文）。
 */
export function findCandidateFiles(index, keywords, maxFiles = 6) {
  if (!keywords.length) return [];
  const scored = [];
  for (const f of index) {
    const haystack = (f.path + '\n' + f.symbols.join('\n')).toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      const k = kw.toLowerCase();
      if (f.path.toLowerCase().includes(k)) score += 3;
      if (haystack.includes(k)) score += 1;
    }
    // 再在文件内容里快速看一眼
    if (score === 0 && f.content) {
      const lower = f.content.toLowerCase();
      for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) { score += 1; }
      }
    }
    if (score > 0) scored.push({ f, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxFiles).map(s => s.f.path);
}

/**
 * 渲染紧凑索引文本给 LLM。
 */
export function renderIndexText(index, maxChars = 30_000) {
  const lines = [];
  let used = 0;
  for (const f of index) {
    const line = `${f.path} :: ${f.symbols.slice(0, 15).join(', ') || '(无符号)'}`;
    if (used + line.length > maxChars) {
      lines.push(`…其余 ${index.length - lines.length} 个文件省略`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}
