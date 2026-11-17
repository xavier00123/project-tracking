import express from 'express';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from './lib/analyze.js';
import { scanProject } from './lib/scanner.js';
import { devinStatus } from './lib/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 快速预扫描：返回文档/代码文件数量，供前端预览
app.post('/api/scan', (req, res) => {
  try {
    const { projectDir } = req.body || {};
    if (!projectDir) return res.status(400).json({ error: '缺少 projectDir' });
    const { docs, codeFiles } = scanProject(projectDir);
    res.json({
      docCount: docs.length,
      codeFileCount: codeFiles.length,
      docs: docs.map(d => d.path).slice(0, 20),
      codeSample: codeFiles.map(f => f.path).slice(0, 20),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Devin CLI / 登录状态
app.get('/api/llm-status', (_req, res) => {
  res.json(devinStatus());
});

// 弹出系统目录选择框（macOS），返回所选路径
app.post('/api/pick-dir', (_req, res) => {
  const script =
    'tell application "System Events"\n' +
    'activate\n' +
    'POSIX path of (choose folder with prompt "选择要分析的项目目录")\n' +
    'end tell';
  const proc = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '', done = false;
  proc.stdout.on('data', d => (out += d));
  proc.stderr.on('data', d => (err += d));
  const timer = setTimeout(() => proc.kill('SIGTERM'), 300_000);
  // 客户端断开时杀掉弹窗进程
  res.on('close', () => { if (!done) { clearTimeout(timer); proc.kill('SIGTERM'); } });
  proc.on('close', code => {
    done = true;
    clearTimeout(timer);
    if (res.writableEnded) return;
    if (code !== 0) {
      // 用户取消 / 超时时 osascript 返回非 0
      if (code === null || /canceled|cancelled|User canceled/i.test(err)) return res.json({ cancelled: true });
      return res.json({ cancelled: true });
    }
    res.json({ path: out.trim().replace(/\/$/, '') });
  });
  proc.on('error', e => {
    done = true;
    clearTimeout(timer);
    if (!res.writableEnded) res.status(500).json({ error: `无法弹出目录选择框：${e.message}` });
  });
});

// 分析接口：流式返回进度事件 + 最终结果
app.post('/api/analyze', async (req, res) => {
  const { projectDir, mode, model } = req.body || {};
  if (!projectDir) return res.status(400).json({ error: '缺少 projectDir' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const emit = msg => send('progress', { msg });

  try {
    if (mode !== 'local') {
      const st = devinStatus();
      if (!st.available) throw new Error('未找到 devin CLI。请确认已安装 Devin Desktop/CLI，或改用本地模式');
      if (!st.authed) throw new Error('devin CLI 未登录。请先在终端运行 `devin auth login`，或改用本地模式');
    }
    const result = await analyzeProject({ projectDir, mode: mode === 'local' ? 'local' : 'devin', model: model || undefined, emit });
    send('result', result);
  } catch (e) {
    send('error', { error: e.message });
  } finally {
    res.end();
  }
});

const PORT = process.env.PORT || 3210;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Doc-Code Diff Tracker: http://localhost:${PORT}`);
});
