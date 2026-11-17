import path from 'node:path';

/**
 * 用例执行器：把 cases.js 产出的结构化步骤用 Playwright 确定性执行。
 * LLM 不参与执行，只负责出计划——结果可复现、可审计。
 */

const ACTION_TIMEOUT = 6000;
const GOTO_TIMEOUT = 15000;

function loc(page, { by, role, name, expected }) {
  const target = name || expected || '';
  switch (by) {
    case 'role': {
      const r = role || guessRole(target);
      return page.getByRole(r, { name: target || undefined }).first();
    }
    case 'label': return page.getByLabel(target).first();
    case 'placeholder': return page.getByPlaceholder(target).first();
    case 'selector': return page.locator(target).first();
    case 'text':
    default: return page.getByText(target, { exact: false }).first();
  }
}

function guessRole(name, action) {
  if (/按钮|button/i.test(name)) return 'button';
  if (/链接|link/i.test(name)) return 'link';
  if (/输入|textbox|input|搜索/i.test(name)) return 'textbox';
  if (action === 'fill' || action === 'select' || action === 'check') return 'textbox';
  return 'button';
}

/**
 * 交互元素的候选定位器链：LLM 给的 by/name 可能和实际可访问名有出入，
 * 按序尝试 role → label → placeholder → text，每个给短超时。
 */
const INPUT_ROLES = new Set(['textbox', 'spinbutton', 'searchbox', 'combobox', 'checkbox']);

function locCandidates(page, step) {
  const target = step.name || step.value || '';
  const role = step.role || guessRole(target, step.action);
  const list = [];
  if (target) {
    list.push(page.getByRole(role, { name: target }).nth(step.nth ?? 0));
    list.push(page.getByLabel(target).first());
    list.push(page.getByPlaceholder(target).first());
    list.push(page.getByText(target, { exact: true }).first());
    list.push(page.getByText(target, { exact: false }).first());
  } else {
    list.push(page.getByRole(role).nth(step.nth ?? 0));
  }
  // fill/select/check 的最后兜底：文档常只说"数字输入框"而不给名字，
  // 名字匹配全失败时按同角色第 nth 个元素试一次（click 不做盲试，避免误点）
  if (['fill', 'select', 'check'].includes(step.action) && INPUT_ROLES.has(role)) {
    list.push(page.getByRole(role).nth(step.nth ?? 0));
  }
  return list;
}

/** 依次尝试候选定位器执行操作；全部失败抛最后一个错误 */
async function tryLocators(page, step, fn) {
  const cands = locCandidates(page, step);
  const perTry = Math.max(1500, Math.floor(ACTION_TIMEOUT / cands.length) + 500);
  let lastErr;
  for (const l of cands) {
    try { return await fn(l, perTry); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function resolveUrl(baseUrl, route) {
  if (/^https?:\/\//.test(route)) return route;
  return baseUrl + (route.startsWith('/') ? route : '/' + route);
}

async function shot(page, shotsDir, name) {
  if (!shotsDir) return null;
  const file = `${name}.png`;
  try {
    await page.screenshot({ path: path.join(shotsDir, file), fullPage: false, timeout: 8000 });
    return file;
  } catch { return null; }
}

/** 执行单条步骤，返回 {desc, ok, error} */
async function runStep(page, baseUrl, step) {
  const desc = `${step.action} ${step.by ? `[${step.by}${step.role ? ':' + step.role : ''}]` : ''}${step.name || step.value || ''}`.trim();
  try {
    switch (step.action) {
      case 'goto':
        await page.goto(resolveUrl(baseUrl, step.value || step.name), { timeout: GOTO_TIMEOUT, waitUntil: 'domcontentloaded' });
        break;
      case 'click':
        await tryLocators(page, { ...step, name: step.name || step.value },
          (l, t) => l.click({ timeout: t }));
        break;
      case 'fill':
        await tryLocators(page, step, (l, t) => l.fill(step.value, { timeout: t }));
        break;
      case 'press':
        await page.keyboard.press(step.name || step.value || 'Enter');
        break;
      case 'select':
        await tryLocators(page, step, (l, t) => l.selectOption(step.value, { timeout: t }));
        break;
      case 'check':
        await tryLocators(page, step, (l, t) => l.check({ timeout: t }));
        break;
      case 'wait': {
        const ms = parseInt(step.value, 10);
        if (ms > 0) await page.waitForTimeout(Math.min(ms, 10000));
        else await loc(page, { by: 'text', name: step.name }).waitFor({ timeout: ACTION_TIMEOUT });
        break;
      }
      default:
        return { desc, ok: false, error: `未知 action: ${step.action}` };
    }
    return { desc, ok: true };
  } catch (e) {
    return { desc, ok: false, error: String(e.message || e).split('\n')[0].slice(0, 200) };
  }
}

/** 评估单条断言，返回 {type, expected, pass, actual} */
async function evalAssertion(page, a, consoleErrors) {
  let pass = false, actual = '';
  try {
    switch (a.type) {
      case 'urlContains':
        actual = page.url();
        pass = actual.includes(a.expected);
        break;
      case 'textVisible': {
        const el = page.getByText(a.expected, { exact: false }).first();
        pass = await el.isVisible({ timeout: 4000 }).catch(() => false);
        actual = pass ? '文本可见' : '文本未出现';
        break;
      }
      case 'elementExists': {
        const el = a.by === 'role' || a.role
          ? page.getByRole(a.role || 'button', { name: a.expected || undefined }).first()
          : page.getByText(a.expected, { exact: false }).first();
        pass = await el.isVisible({ timeout: 4000 }).catch(() => false);
        actual = pass ? '元素存在' : '元素未找到';
        break;
      }
      case 'elementMissing': {
        const el = a.role
          ? page.getByRole(a.role, { name: a.expected || undefined }).first()
          : page.getByText(a.expected, { exact: false }).first();
        pass = !(await el.isVisible({ timeout: 3000 }).catch(() => false));
        actual = pass ? '元素不存在（符合预期）' : '元素意外出现';
        break;
      }
      case 'valueEquals': {
        const body = await page.locator('body').innerText({ timeout: 4000 }).catch(() => '');
        const norm = s => s.replace(/\s+/g, ' ').trim();
        pass = norm(body).includes(norm(a.expected));
        actual = pass ? '页面包含期望值' : `页面未包含 "${a.expected}"`;
        break;
      }
      case 'noConsoleError':
        pass = consoleErrors.length === 0;
        actual = pass ? '无 console 错误' : `${consoleErrors.length} 个 console 错误`;
        break;
      default:
        actual = `未知断言类型 ${a.type}`;
    }
  } catch (e) {
    actual = String(e.message || e).split('\n')[0].slice(0, 150);
  }
  return { type: a.type, expected: a.expected, role: a.role, by: a.by, pass, actual };
}

/**
 * 执行一个用例。
 * @param {object} env { page, baseUrl, shotsDir, consoleErrors }
 */
export async function runCase(env, tc) {
  const { page, baseUrl, shotsDir, consoleErrors } = env;
  const rec = {
    id: tc.id, name: tc.name, source: tc.source, quote: tc.quote,
    expected: tc.assertions.map(a => `${a.type}:${a.expected}`).join('；') || '页面可用',
    steps: [], assertions: [], status: 'untestable', finalShot: null,
  };

  // 进入起始页
  try {
    const resp = await page.goto(resolveUrl(baseUrl, tc.startRoute), { timeout: GOTO_TIMEOUT, waitUntil: 'domcontentloaded' });
    if (resp && resp.status() >= 404) {
      rec.steps.push({ desc: `goto ${tc.startRoute}`, ok: false, error: `HTTP ${resp.status()}` });
      rec.status = 'missing';
      rec.finalShot = await shot(page, shotsDir, `case-${tc.id}-fail`);
      return rec;
    }
    rec.steps.push({ desc: `goto ${tc.startRoute}`, ok: true });
  } catch (e) {
    rec.steps.push({ desc: `goto ${tc.startRoute}`, ok: false, error: String(e.message).split('\n')[0].slice(0, 200) });
    rec.status = 'missing';
    return rec;
  }

  consoleErrors.length = 0; // 只统计本用例期间的错误

  let stepFailed = false;
  for (const [i, step] of tc.steps.entries()) {
    const r = await runStep(page, baseUrl, step);
    r.shot = await shot(page, shotsDir, `case-${tc.id}-step-${i + 1}`);
    rec.steps.push(r);
    if (!r.ok) { stepFailed = true; break; }
    await page.waitForTimeout(300); // 给 UI 反应留一点时间
  }

  // 即使步骤失败也尝试跑断言（部分断言仍可提供信息）
  for (const a of tc.assertions) {
    rec.assertions.push(await evalAssertion(page, a, consoleErrors));
  }
  rec.finalShot = await shot(page, shotsDir, `case-${tc.id}-final`);

  const passed = rec.assertions.filter(a => a.pass).length;
  const failed = rec.assertions.length - passed;
  // missing 只留给"入口不可达"（goto 失败已在上面 return）；
  // 页面能走通但结果不符 → divergent；交互元素缺失到不了验证点 → untestable
  if (failed === 0 && !stepFailed) rec.status = 'verified';
  else if (stepFailed && passed === 0) rec.status = 'untestable';
  else rec.status = 'divergent';
  rec.actual = rec.assertions.map(a => a.actual).filter(Boolean).join('；') ||
    (stepFailed ? '步骤执行失败' : '');
  return rec;
}
