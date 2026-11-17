import { spawnSync } from 'node:child_process';
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

/** 返回 { available, authed, detail } */
export function devinStatus() {
  const bin = findDevinBin();
  if (!bin) return { available: false, authed: false, detail: '未找到 devin CLI' };
  const res = spawnSync(bin, ['auth', 'status'], { encoding: 'utf8', timeout: 15_000, env: CLEAN_ENV });
  const out = (res.stdout || '') + (res.stderr || '');
  const authed = res.status === 0 && !/not logged in/i.test(out);
  return { available: true, authed, detail: out.trim().split('\n')[0] || (authed ? '已登录' : '未登录'), bin };
}

/**
 * 调用 Devin 模型。messages 合并为单个 prompt 通过 --prompt-file 传入。
 */
export async function chat({ messages, model, timeoutMs = 300_000 }) {
  const bin = findDevinBin();
  if (!bin) throw new Error('未找到 devin CLI（需要 Devin Desktop / devin CLI）');

  const prompt = messages
    .map(m => (m.role === 'system' ? `【系统指令】\n${m.content}` : m.content))
    .join('\n\n');

  const tmp = path.join(os.tmpdir(), `dcdt-prompt-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(tmp, prompt, { mode: 0o600 });
  try {
    const baseArgs = ['--respect-workspace-trust', 'false'];
    if (model) baseArgs.push('--model', model);
    const opts = {
      encoding: 'utf8',
      cwd: os.tmpdir(), // 在临时目录运行，避免 agent 触碰用户项目
      env: CLEAN_ENV,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    };
    // 优先 --prompt-file（适合长 prompt）；不兼容则退回内联参数
    let res = spawnSync(bin, [...baseArgs, '-p', '--prompt-file', tmp], opts);
    if (res.status !== 0 && /prompt-file|unknown|unrecognized|invalid/i.test(res.stderr || '')) {
      res = spawnSync(bin, [...baseArgs, '-p', prompt], opts);
    }
    if (res.error) throw res.error;
    if (res.status !== 0) {
      const err = ((res.stderr || '') + '\n' + (res.stdout || '')).trim();
      throw new Error(`devin CLI 返回错误 (${res.status}): ${err.slice(0, 400)}`);
    }
    const out = (res.stdout || '').trim();
    if (!out) throw new Error('devin CLI 返回为空');
    return out;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function parseJson(content) {
  // 模型可能包 markdown fence 或带额外文字，做容错提取
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1];
  const first = s.search(/[{[]/);
  const last = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s);
}
