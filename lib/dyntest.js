import path from 'node:path';
import { scanProject } from './scanner.js';
import { extractTestPlan, localTestPlan } from './cases.js';
import { launchTarget, checkUrl, detectLaunch } from './runner.js';
import { openPage, closeBrowser, elementInventory, interactiveElements } from './browser.js';
import { runCase } from './execute.js';
import { analyzeScreenshot } from './vision.js';
import { newRun, saveReport } from './report.js';

/**
 * 动态验收测试主编排：
 *   连接/启动目标 → 文档提取验收标准 → 页面巡检（截图+元素盘点+视觉复核）
 *   → 用例执行（交互+断言）→ 汇总报告并落盘
 */
export async function runDynamicTest(opts) {
  const {
    projectDir, url, command, port, readyPath,
    mode = 'devin', model, emit,
    vision = true,           // devin 模式下是否逐页做视觉复核
    maxVisionPages = 8,      // 视觉复核页数上限（每次是一次 agent session）
  } = opts;
  const useLLM = mode === 'devin';
  const run = newRun();
  const startedAt = new Date().toISOString();
  const rel = p => path.relative(run.dir, p).split(path.sep).join('/');

  // ---- 1. 连接或启动目标 ----
  let baseUrl, cleanup = () => {}, preSteps = [];
  if (url) {
    emit?.(`连接已运行目标：${url}`);
    baseUrl = await checkUrl(url);
    if (projectDir) preSteps = (detectLaunch(projectDir)?.preSteps) || [];
  } else {
    if (!projectDir) throw new Error('launch 模式必须提供 projectDir');
    const t = await launchTarget({ projectDir, command, port, readyPath, emit });
    baseUrl = t.baseUrl; cleanup = t.kill; preSteps = t.preSteps;
  }

  try {
    // ---- 2. 文档 → 验收标准 ----
    let plan = { pages: [], cases: [] };
    let docs = [];
    if (projectDir) {
      emit?.('扫描项目文档…');
      docs = scanProject(projectDir).docs;
      emit?.(`发现 ${docs.length} 个文档`);
    }
    if (docs.length) {
      if (useLLM) {
        emit?.('Devin 模型提取验收标准与测试用例（通常需 1-3 分钟）…');
        plan = await extractTestPlan(docs, model, emit);
      } else {
        emit?.('本地模式：启发式提取页面与元素…');
        plan = localTestPlan(docs);
      }
    }
    // 确保首页在巡检列表
    if (!plan.pages.some(p => p.route === '/' || p.route === '')) {
      plan.pages.unshift({ route: '/', name: '首页', description: '', expectedElements: [] });
    }
    emit?.(`验收标准：${plan.pages.length} 个页面、${plan.cases.length} 个用例`);

    // ---- 3. 浏览器会话 ----
    const { context, page, consoleErrors, failedRequests } = await openPage();
    try {
      // preSteps（如登录），失败不阻塞但记录
      if (preSteps.length) {
        emit?.(`执行前置步骤（${preSteps.length} 步，如登录）…`);
        const pre = await runCase(
          { page, baseUrl, shotsDir: null, consoleErrors },
          { id: 0, name: '前置步骤', startRoute: '/', steps: preSteps, assertions: [] });
        emit?.(`前置步骤：${pre.steps.filter(s => s.ok).length}/${pre.steps.length} 成功`);
      }

      // ---- 4. 页面巡检 ----
      const pages = [];
      let visionBudget = useLLM && vision ? maxVisionPages : 0;
      for (const p of plan.pages) {
        emit?.(`巡检页面 ${p.route}…`);
        const rec = { route: p.route, name: p.name, ok: false, elements: [], interactive: [], missingExpected: [], anomalies: [], shot: null, vision: null, consoleErrors: [] };
        try {
          const resp = await page.goto(baseUrl + (p.route.startsWith('/') ? p.route : '/' + p.route),
            { timeout: 15000, waitUntil: 'domcontentloaded' });
          rec.httpStatus = resp?.status();
          rec.ok = !resp || resp.status() < 400;
          emit?.(`  ${p.route} → HTTP ${rec.httpStatus ?? '-'}，截图+元素盘点…`);
          await page.waitForTimeout(400);
          consoleErrors.length = 0;
          const shotFile = `page-${p.route.replace(/[^\w-]+/g, '_') || 'index'}.png`;
          try {
            await page.screenshot({ path: path.join(run.shotsDir, shotFile), fullPage: true, timeout: 10000 });
            rec.shot = 'shots/' + shotFile;
          } catch {}
          rec.elements = await elementInventory(page);
          rec.interactive = interactiveElements(rec.elements);
          rec.consoleErrors = consoleErrors.slice(0, 5);
          emit?.(`  ${p.route}：${rec.interactive.length} 个可交互元素` +
            (rec.missingExpected.length ? `，${rec.missingExpected.length} 个预期元素缺失` : ''));
          // 预期元素 vs 实际（aria 侧粗比对：名称包含匹配）
          const actualNames = rec.elements.map(e => (e.name || '').toLowerCase());
          rec.missingExpected = p.expectedElements.filter(e =>
            e.name && !actualNames.some(n => n.includes(e.name.toLowerCase())));
          // devin 视觉复核
          if (visionBudget > 0 && rec.shot) {
            visionBudget--;
            emit?.(`视觉复核 ${p.route}（Devin 模型读截图）…`);
            try {
              rec.vision = await analyzeScreenshot(run.shotsDir, shotFile, { model, expectedElements: p.expectedElements, emit });
              rec.anomalies = rec.vision.anomalies;
              // 视觉与 aria 取并集修正 missingExpected
              if (rec.vision.expectedFound?.length) {
                rec.missingExpected = rec.missingExpected.filter(e =>
                  !rec.vision.expectedFound.some(f => e.name && f.toLowerCase().includes(e.name.toLowerCase())));
              }
            } catch (e) {
              emit?.(`视觉复核失败（忽略）：${String(e.message).slice(0, 80)}`);
            }
          }
        } catch (e) {
          rec.error = String(e.message).split('\n')[0].slice(0, 200);
        }
        pages.push(rec);
      }

      // ---- 5. 用例执行 ----
      const caseResults = [];
      for (const tc of plan.cases) {
        emit?.(`执行用例 ${tc.id}/${plan.cases.length}：${tc.name}`);
        const env = { page: await context.newPage(), baseUrl, shotsDir: run.shotsDir, consoleErrors, failedRequests };
        try {
          const r = await runCase(env, tc);
          for (const k of ['finalShot']) if (r[k]) r[k] = 'shots/' + r[k];
          for (const s of r.steps) if (s.shot) s.shot = 'shots/' + s.shot;
          caseResults.push(r);
          emit?.(`  → ${r.status}`);
        } finally {
          await env.page.close().catch(() => {});
        }
      }

      // ---- 6. 汇总 ----
      const counts = { verified: 0, divergent: 0, missing: 0, untestable: 0 };
      for (const c of caseResults) counts[c.status] = (counts[c.status] || 0) + 1;
      const pagesOk = pages.filter(p => p.ok).length;
      const report = {
        runId: run.id,
        targetUrl: baseUrl,
        project: projectDir ? path.resolve(projectDir) : null,
        mode, model: model || null,
        startedAt,
        finishedAt: new Date().toISOString(),
        summary: {
          pagesTotal: pages.length, pagesOk,
          casesTotal: caseResults.length, ...counts,
          verifiedRate: caseResults.length ? Math.round((counts.verified / caseResults.length) * 1000) / 10 : 0,
        },
        pages,
        cases: caseResults,
        plan: { pages: plan.pages.map(({ route, name, expectedElements }) => ({ route, name, expectedElements })) },
      };
      saveReport(run.id, report);
      emit?.(`完成：${counts.verified} 通过 / ${counts.divergent} 不符 / ${counts.missing} 缺失 / ${counts.untestable} 无法测试`);
      return report;
    } finally {
      await context.close().catch(() => {});
      closeBrowser();
    }
  } finally {
    cleanup();
  }
}
