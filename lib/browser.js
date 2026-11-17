import { chromium } from 'playwright-core';

/**
 * Playwright 封装：启动系统 Chrome（playwright-core 不捆绑浏览器，
 * 依次尝试 chrome / msedge channel，最后回落到 executablePath 常见路径）。
 */

const LAUNCH_CHANNELS = ['chrome', 'msedge'];
const FALLBACK_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

let _browser = null;

export async function getBrowser() {
  if (_browser?.isConnected()) return _browser;
  let lastErr;
  for (const channel of LAUNCH_CHANNELS) {
    try {
      _browser = await chromium.launch({ channel, headless: true });
      return _browser;
    } catch (e) { lastErr = e; }
  }
  for (const executablePath of FALLBACK_PATHS) {
    try {
      _browser = await chromium.launch({ executablePath, headless: true });
      return _browser;
    } catch (e) { lastErr = e; }
  }
  throw new Error(
    '无法启动浏览器：未找到系统 Chrome/Edge。' +
    '请安装 Chrome，或执行 `npx playwright install chromium` 后改用 playwright 包。' +
    (lastErr ? ` (${lastErr.message.slice(0, 120)})` : ''));
}

export async function closeBrowser() {
  try { await _browser?.close(); } catch {}
  _browser = null;
}

/**
 * 打开一个带观测能力的页面：收集 console 错误与失败的网络请求。
 */
export async function openPage(viewport = { width: 1280, height: 900 }) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport,
    locale: 'zh-CN',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on('requestfailed', req => {
    failedRequests.push(`${req.method()} ${req.url()} ${req.failure()?.errorText || ''}`.slice(0, 300));
  });
  page.on('response', res => {
    if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`.slice(0, 300));
  });
  return { context, page, consoleErrors, failedRequests };
}

/**
 * 通过 aria snapshot 提取结构化元素清单。
 * 返回 [{role, name}]，role 为 button/link/textbox/heading 等。
 */
export async function elementInventory(page) {
  let snap = '';
  try {
    snap = await page.locator('body').ariaSnapshot({ timeout: 8000 });
  } catch {
    try { snap = await page.locator('html').ariaSnapshot({ timeout: 5000 }); } catch { return []; }
  }
  const elements = [];
  // aria snapshot 行形如: `- button "提交" [active]` 或 `- link "首页"` 或 `- heading "标题" [level=1]`
  for (const line of String(snap).split('\n')) {
    const m = line.match(/^\s*-\s*([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/);
    if (!m) continue;
    const role = m[1];
    if (role === 'generic' || role === 'none') continue; // 跳过无意义容器
    elements.push({ role, name: (m[2] || '').replace(/\\"/g, '"') });
  }
  // 去重
  const seen = new Set();
  return elements.filter(e => {
    const k = e.role + '|' + e.name;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 可交互元素（用于"页面上有哪些按钮"的展示与对账） */
export function interactiveElements(elements) {
  const INTERACTIVE = new Set([
    'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio',
    'menuitem', 'tab', 'switch', 'slider', 'searchbox', 'spinbutton',
  ]);
  return elements.filter(e => INTERACTIVE.has(e.role));
}
