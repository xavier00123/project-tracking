import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const RUNS_DIR = path.join(ROOT, 'runs');

/** 创建一次运行目录：runs/<ts>-<rand>/ 含 shots/ 子目录 */
export function newRun() {
  const id = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
    + '-' + Math.random().toString(36).slice(2, 7);
  const dir = path.join(RUNS_DIR, id);
  const shotsDir = path.join(dir, 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });
  return { id, dir, shotsDir };
}

export function saveReport(id, report) {
  fs.writeFileSync(path.join(RUNS_DIR, id, 'report.json'), JSON.stringify(report, null, 2));
}

export function getRun(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  const f = path.join(RUNS_DIR, id, 'report.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

export function listRuns() {
  try {
    return fs.readdirSync(RUNS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const r = getRun(d.name);
        return r ? {
          id: d.name,
          targetUrl: r.targetUrl,
          project: r.project,
          startedAt: r.startedAt,
          summary: r.summary,
        } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.id.localeCompare(a.id))
      .slice(0, 50);
  } catch { return []; }
}
