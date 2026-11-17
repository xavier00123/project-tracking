import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 通过 Devin CLI 的非交互模式（devin -p）调用用户配置的 Devin 模型，
 * 无需额外配置 API Key —— 复用 `devin auth login` 的登录态。
 */

const CANDIDATE_BINS = [
  '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin',
  `${os.homedir()}/.local/bin/devin`,
  '/usr/local/bin/devin',
  '/opt/homebrew/bin/devin',
];

// 从 Devin Desktop / Windsurf 终端启动时会继承 ACP_BACKEND、WINDSURF_API_KEY 等
// 变量；ACP 模式下 CLI 故意忽略本地登录态，需剥离后再调用
const CLEAN_ENV = (() => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) {
    if (k === 'ACP_BACKEND' || k.startsWith('ACP_') || k.startsWith('WINDSURF_')) delete e[k];
  }
  return e;
})();

let _bin = null;
export function findDevinBin() {
  if (_bin) return _bin;
  // PATH 优先
  const which = spawnSync('devin', ['version'], { encoding: 'utf8', timeout: 10_000, env: CLEAN_ENV });
  if (!which.error && which.status === 0) return (_bin = 'devin');
  for (const p of CANDIDATE_BINS) {
    if (fs.existsSync(p)) return (_bin = p);
  }
  return null;
}

/** 返回 { available, authed, detail, defaultModel, models } */
export function devinStatus() {
  const bin = findDevinBin();
  if (!bin) return { available: false, authed: false, detail: '未找到 devin CLI', defaultModel: null, models: [] };
  const res = spawnSync(bin, ['auth', 'status'], { encoding: 'utf8', timeout: 15_000, env: CLEAN_ENV });
  const out = (res.stdout || '') + (res.stderr || '');
  const authed = res.status === 0 && !/not logged in/i.test(out);
  return {
    available: true, authed,
    detail: out.trim().split('\n')[0] || (authed ? '已登录' : '未登录'),
    bin,
    defaultModel: authed ? effectiveDefaultModel() : null,
    models: authed ? listModels(bin) : [],
  };
}

/** 与 devin CLI 相同的解析顺序：DEVIN_MODEL > agent.model > 内置默认 */
function effectiveDefaultModel() {
  if (CLEAN_ENV.DEVIN_MODEL) return CLEAN_ENV.DEVIN_MODEL;
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.config/devin/config.json'), 'utf8'));
    if (cfg?.agent?.model) return cfg.agent.model;
  } catch {}
  return 'swe-2-high'; // devin CLI v3000.13.4 内置默认（未配置时实测解析值）
}

let _modelsCache = null;
/** 解析 `devin models` 输出，返回可选 model uid 列表（失败返回 []） */
function listModels(bin) {
  if (_modelsCache) return _modelsCache;
  const res = spawnSync(bin, ['models'], { encoding: 'utf8', timeout: 30_000, env: CLEAN_ENV });
  if (res.status !== 0) return [];
  const uids = [];
  for (const line of (res.stdout || '').split('\n')) {
    // 模型行形如 "  swe-2-high   SWE-2 High  [262K context, Free]"，别名行 "  aliases: swe"
    const m = line.match(/^\s{2,}([a-z0-9][a-z0-9._-]*)\s{2,}\S/i);
    if (m) uids.push(m[1]);
    const a = line.match(/^\s+aliases?:\s*(.+)$/i);
    if (a) uids.push(...a[1].split(/[,\s]+/).filter(Boolean));
  }
  const list = [...new Set(uids)];
  if (list.length) _modelsCache = list;
  return list;
}

/** ATIF 导出的单个工具调用 → 一行可读描述 */
function describeToolCall(tc) {
  const fn = tc.function_name || 'tool';
  const a = tc.arguments || {};
  let brief = '';
  if (fn === 'exec') brief = a.command;
  else if (fn === 'read' || fn === 'edit' || fn === 'write') brief = a.file_path;
  else if (fn === 'grep') brief = `${a.pattern} @ ${a.path || '.'}`;
  else if (fn === 'find_file_by_name') brief = a.pattern;
  else brief = JSON.stringify(a);
  return `🔧 ${fn}${brief ? ' ' + String(brief).replace(/\s+/g, ' ').trim().slice(0, 90) : ''}`;
}

/** 从（可能写到一半的）ATIF 文本里提取已完整的 step 对象。
 *  export 边跑边写，"steps" 数组运行期间不闭合 → 逐个平衡提取。 */
function extractSteps(text) {
  const idx = text.indexOf('"steps"');
  if (idx < 0) return [];
  const arrStart = text.indexOf('[', idx);
  if (arrStart < 0) return [];
  const steps = [];
  let i = arrStart + 1;
  while (i < text.length) {
    while (i < text.length && text[i] !== '{') {
      if (text[i] === ']') return steps;
      i++;
    }
    if (i >= text.length) break;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) break; // 写了一半的对象，下轮再说
    try { steps.push(JSON.parse(text.slice(i, end + 1))); } catch {}
    i = end + 1;
  }
  return steps;
}

/**
 * 轮询 devin --export 的 ATIF 文件，把 agent 新完成的动作实时 emit 出来。
 * 运行中文件是增量写的（steps 数组未闭合），用流式提取容忍半截文件。
 */
export function tailExport(file, emit, intervalMs = 1200) {
  let last = 0;
  const poll = () => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    const steps = extractSteps(text);
    for (; last < steps.length; last++) {
      const s = steps[last];
      if (s?.source !== 'agent') continue;
      if (Array.isArray(s.tool_calls)) {
        for (const tc of s.tool_calls) emit?.(describeToolCall(tc));
      }
      const msg = (s.message || '').trim().replace(/\s+/g, ' ');
      // 跳过最终答案本体（JSON/fence 开头）——那是返回结果不是过程叙述
      if (msg && !/^[{[`]/.test(msg)) emit?.(`💭 ${msg.slice(0, 120)}`);
    }
  };
  const iv = setInterval(poll, intervalMs);
  iv.unref?.();
  return () => { poll(); clearInterval(iv); }; // 收尾补一轮，不丢最后的 step
}

/** 异步执行 devin CLI，收集输出。spawnSync 会冻结整个 Node 事件循环，禁用。 */
function runDevin(bin, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, {
      cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`devin CLI 超时（${opts.timeoutMs / 1000}s）`));
    }, opts.timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => { clearTimeout(timer); resolve({ status: code ?? -1, out, err }); });
  });
}

/**
 * LLM 调用心跳：长时间等待时周期性 emit，防止用户以为卡住。
 * 返回停止函数。chat() 是异步的，期间事件循环正常工作。
 */
export function heartbeat(emit, label, intervalMs = 15000) {
  const t0 = Date.now();
  const iv = setInterval(
    () => emit?.(`${label}…已等待 ${Math.round((Date.now() - t0) / 1000)}s`),
    intervalMs);
  iv.unref?.();
  return () => clearInterval(iv);
}

/**
 * 调用 Devin 模型。messages 合并为单个 prompt 通过 --prompt-file 传入。
 * @param {object} opts { messages, model?, timeoutMs?, cwd? }
 *   cwd 指定 agent 工作目录——视觉分析时指向截图目录，agent 即可用文件工具读 PNG。
 */
export async function chat({ messages, model, timeoutMs = 300_000, cwd, emit }) {
  const bin = findDevinBin();
  if (!bin) throw new Error('未找到 devin CLI（需要 Devin Desktop / devin CLI）');

  const prompt = messages
    .map(m => (m.role === 'system' ? `【系统指令】\n${m.content}` : m.content))
    .join('\n\n');

  const stamp = `${process.pid}-${Date.now()}`;
  const tmp = path.join(os.tmpdir(), `dcdt-prompt-${stamp}.txt`);
  const exp = path.join(os.tmpdir(), `dcdt-export-${stamp}.json`);
  fs.writeFileSync(tmp, prompt, { mode: 0o600 });
  // 实时细节：tail ATIF 导出文件报 agent 动作；心跳兜底长思考空窗
  const stopTail = emit ? tailExport(exp, emit) : () => {};
  const stopBeat = emit ? heartbeat(emit, '等待 Devin 响应', 15_000) : () => {};
  try {
    const baseArgs = ['--respect-workspace-trust', 'false', '--export', exp];
    if (model) baseArgs.push('--model', model);
    const opts = {
      cwd: cwd || os.tmpdir(), // 默认临时目录，避免 agent 触碰用户项目
      env: CLEAN_ENV,
      timeoutMs,
    };
    // 优先 --prompt-file（适合长 prompt）；不兼容则退回内联参数
    let res = await runDevin(bin, [...baseArgs, '-p', '--prompt-file', tmp], opts);
    if (res.status !== 0 && /prompt-file|unknown|unrecognized|invalid/i.test(res.err || '')) {
      res = await runDevin(bin, [...baseArgs, '-p', prompt], opts);
    }
    if (res.status !== 0) {
      const err = ((res.err || '') + '\n' + (res.out || '')).trim();
      throw new Error(`devin CLI 返回错误 (${res.status}): ${err.slice(0, 400)}`);
    }
    const out = (res.out || '').trim();
    if (!out) throw new Error('devin CLI 返回为空');
    return out;
  } finally {
    stopTail();
    stopBeat();
    fs.rmSync(tmp, { force: true });
    fs.rmSync(exp, { force: true });
  }
}

export function parseJson(content) {
  // 模型可能带 markdown fence、前后解释文字、甚至多个 JSON 块。
  // 按括号平衡提取"第一个完整 JSON 值"，避免跨块截取导致语法错误。
  let s = String(content).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.search(/[{[]/);
  if (start < 0) throw new Error(`模型输出不含 JSON：${s.slice(0, 150)}`);

  const open = s[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { end = i; break; } }
  }
  const cand = end > start ? s.slice(start, end + 1) : s.slice(start);
  try {
    return JSON.parse(cand);
  } catch (e) {
    throw new Error(`解析模型 JSON 失败：${e.message}；输出片段：${s.slice(0, 200)}`);
  }
}
