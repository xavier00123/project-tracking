import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 目标项目启动器。
 * 两种入口：
 *  - url 模式：用户给出已运行的 URL，不启动任何东西
 *  - launch 模式：从项目目录探测启动方式并 spawn
 *
 * 配置来源优先级：qa.config.json > package.json scripts > 显式参数
 */

const COMMON_PORTS = [3000, 5173, 8000, 8080, 5000, 4000, 4173, 3210, 9000];

/** 探测单个目录的启动方式，返回候选或 null；score 越高越优先（前端 dev server > 后端构建） */
function probeDir(dir) {
  const has = f => fs.existsSync(path.join(dir, f));
  const mk = (command, source, score) =>
    ({ command, baseUrl: null, port: null, readyPath: '/', env: {}, preSteps: [], dir, source, score });
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};
    const name = ['dev', 'serve', 'preview', 'start'].find(s => scripts[s]);
    if (name) return mk(`npm run ${name}`, `package.json#scripts.${name}`, 10);
    // dev:h5 / dev:web 之类的带前缀脚本（如 Taro）——优先级低一档
    const devPrefixed = Object.keys(scripts).find(s => /^dev[:.-]/.test(s));
    if (devPrefixed) return mk(`npm run ${devPrefixed}`, `package.json#scripts.${devPrefixed}`, 6);
  } catch {}
  // Java / Kotlin
  if (has('mvnw') || has('pom.xml'))
    return mk(has('mvnw') ? './mvnw spring-boot:run' : 'mvn spring-boot:run', has('mvnw') ? 'mvnw' : 'pom.xml', 4);
  if (has('gradlew') || has('build.gradle') || has('build.gradle.kts'))
    return mk(has('gradlew') ? './gradlew bootRun' : 'gradle bootRun', has('gradlew') ? 'gradlew' : 'build.gradle', 4);
  // Python
  if (has('manage.py')) return mk('python3 manage.py runserver', 'manage.py', 3);
  for (const f of ['app.py', 'main.py', 'server.py', 'run.py']) {
    if (has(f)) return mk(`python3 ${f}`, f, 3);
  }
  // Go / Rust / 其他
  if (has('go.mod')) return mk('go run .', 'go.mod', 3);
  if (has('Cargo.toml')) return mk('cargo run', 'Cargo.toml', 3);
  if (has('Makefile')) return mk('make run', 'Makefile', 2);
  return null;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'out', '__pycache__', '.idea', '.vscode', 'coverage', 'docs', 'design']);

/** 探测项目启动方式，返回 {command, dir, port?, readyPath?, env?, source} 或 null */
export function detectLaunch(projectDir) {
  const root = path.resolve(projectDir);
  // 1) qa.config.json 显式配置（工作目录可指向子目录）
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'qa.config.json'), 'utf8'));
    if (cfg.startCommand || cfg.baseUrl) {
      return {
        command: cfg.startCommand || null,
        baseUrl: cfg.baseUrl || null,
        port: cfg.port || null,
        readyPath: cfg.readyPath || '/',
        env: cfg.env || {},
        preSteps: Array.isArray(cfg.preSteps) ? cfg.preSteps : [],
        dir: path.resolve(root, cfg.dir || '.'),
        source: 'qa.config.json',
      };
    }
  } catch {}
  // 2) 根目录直接探测
  const atRoot = probeDir(root);
  if (atRoot) return atRoot;
  // 3) monorepo：递归 ≤3 层子目录收集候选，取分数最高者（同分取更浅的目录）
  const candidates = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const sub = path.join(dir, e.name);
      const c = probeDir(sub);
      if (c) candidates.push(c);
      walk(sub, depth + 1);
    }
  };
  walk(root, 1);
  candidates.sort((a, b) => b.score - a.score ||
    path.relative(root, a.dir).split(path.sep).length - path.relative(root, b.dir).split(path.sep).length);
  const best = candidates[0];
  if (best) best.source = `${path.relative(root, best.dir)}/${best.source}`;
  return best || null;
}

function probe(url, timeoutMs = 1200) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    .then(r => r.status < 500)
    .catch(() => false);
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(url)) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

/** 从 stdout 里找端口：URL 形式，或 "port 8080" / "port(s): 8080" / "listening on 3000" 等日志 */
function urlFromLog(text) {
  let m = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/);
  if (m) return +m[1];
  m = text.match(/port\(s\)?:?\s*:?(\d{2,5})/i) ||
      text.match(/(?:listening|running|started|serving)[^\n]{0,40}?(?:port|on|:)\s*(\d{2,5})/i);
  return m ? +m[1] : null;
}

/**
 * 启动目标项目并等待就绪。
 * @param {object} opts { projectDir, command?, port?, readyPath?, env?, timeoutMs?, emit }
 * @returns {Promise<{baseUrl, proc, kill, log}>}
 */
export async function launchTarget(opts) {
  const { projectDir, command, port, readyPath = '/', env = {}, timeoutMs = 90_000, emit } = opts;
  const detected = detectLaunch(projectDir) || {};
  const cmd = command || detected.command;
  if (!cmd) {
    throw new Error('无法探测启动命令：已尝试 package.json 脚本 / Maven / Gradle / Python / Go（含 ≤3 层子目录）。' +
      '请在根目录 qa.config.json 配置 startCommand，或改用"已运行 URL"模式');
  }

  const workDir = command ? path.resolve(projectDir) : (detected.dir || path.resolve(projectDir));
  const relDir = path.relative(path.resolve(projectDir), workDir);
  emit?.(`启动目标项目：${cmd}（来源 ${detected.source || '显式参数'}${relDir ? `，工作目录 ${relDir}` : ''}）`);
  const proc = spawn(cmd, {
    cwd: workDir,
    shell: true,
    detached: true,              // 独立进程组，便于整组 kill
    env: { ...process.env, ...env, ...(port ? { PORT: String(port) } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', d => { log += d; if (log.length > 200_000) log = log.slice(-100_000); });
  proc.stderr.on('data', d => { log += d; if (log.length > 200_000) log = log.slice(-100_000); });

  const kill = () => {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} }, 3000).unref();
  };

  // spawn 前记录已对外响应的端口——预先存在的服务（包括本工具自己）不能算作目标
  const wantPort = port || detected.port;
  const rp = readyPath || detected.readyPath || '/';
  const preExisting = new Set();
  if (!wantPort) {
    for (const p of COMMON_PORTS) {
      if (await probe(`http://127.0.0.1:${p}${rp}`)) preExisting.add(p);
    }
  }

  // 等待就绪：stdout 解析出的端口最优先，然后指定端口，最后扫常用端口（排除已有服务）
  const deadline = Date.now() + timeoutMs;
  let baseUrl = null;

  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      kill();
      throw new Error(`目标进程退出（code=${proc.exitCode}）。输出末尾：\n${log.slice(-800)}`);
    }
    const loggedPort = urlFromLog(log);
    const ports = [...new Set([loggedPort, wantPort, ...COMMON_PORTS].filter(Boolean))]
      .filter(p => p === loggedPort || p === wantPort || !preExisting.has(p));
    for (const p of ports) {
      const candidate = `http://127.0.0.1:${p}${rp}`;
      if (await probe(candidate)) {
        baseUrl = `http://127.0.0.1:${p}`;
        break;
      }
    }
    if (baseUrl) break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (!baseUrl) {
    kill();
    throw new Error(`等待目标就绪超时（${timeoutMs / 1000}s）。输出末尾：\n${log.slice(-800)}`);
  }
  emit?.(`目标已就绪：${baseUrl}`);
  return { baseUrl, proc, kill, log: () => log, preSteps: detected.preSteps || [] };
}

/** 校验用户给的已运行 URL 可达 */
export async function checkUrl(url, readyPath = '/') {
  const base = url.replace(/\/+$/, '');
  const ok = await probe(base + (readyPath.startsWith('/') ? readyPath : '/'));
  if (!ok) throw new Error(`无法访问 ${base}（请确认目标项目已在运行）`);
  return base;
}
