import { chat, parseJson, heartbeat } from './llm.js';
import { keywordsOf } from './codeindex.js';

/**
 * 文档 → 可执行的验收标准与测试用例。
 * LLM 只产出"结构化测试计划"（JSON），实际执行由 Playwright 完成。
 *
 * 输出结构：
 * {
 *   pages: [{route, name, description, expectedElements:[{role,name}]}],
 *   cases: [{
 *     name, source, quote, startRoute,
 *     steps: [{action, by, name, value}],
 *     assertions: [{type, by, expected}]
 *   }]
 * }
 */

const STEP_ACTIONS = new Set(['goto', 'click', 'fill', 'press', 'select', 'wait', 'check']);
const ASSERT_TYPES = new Set(['urlContains', 'textVisible', 'elementExists', 'elementMissing', 'valueEquals', 'noConsoleError']);
const BY_KINDS = new Set(['role', 'text', 'label', 'placeholder', 'selector']);

function sanitizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter(s => s && STEP_ACTIONS.has(s.action))
    .slice(0, 12)
    .map(s => ({
      action: s.action,
      by: BY_KINDS.has(s.by) ? s.by : 'text',
      role: s.role ? String(s.role).slice(0, 30) : undefined,
      name: String(s.name ?? '').slice(0, 120),
      value: String(s.value ?? '').slice(0, 300),
      nth: Number.isInteger(s.nth) && s.nth >= 0 ? s.nth : undefined,
    }));
}

function sanitizeAssertions(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(a => a && ASSERT_TYPES.has(a.type))
    .slice(0, 8)
    .map(a => ({
      type: a.type,
      by: BY_KINDS.has(a.by) ? a.by : 'text',
      role: a.role ? String(a.role).slice(0, 30) : undefined,
      expected: String(a.expected ?? '').slice(0, 200),
    }));
}

function sanitizeElements(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 40).map(e => ({
    role: String(e.role || '').toLowerCase().slice(0, 30),
    name: String(e.name || '').slice(0, 80),
  })).filter(e => e.role || e.name);
}

/* -------------------- Devin 模型提取 -------------------- */

export async function extractTestPlan(docs, model, emit) {
  const docsText = docs
    .map(d => `===== 文档: ${d.path} =====\n${d.content}`)
    .join('\n\n')
    .slice(0, 80_000);

  const messages = [
    {
      role: 'system',
      content:
        '你是第三方验收测试工程师。从项目文档中提取"可在浏览器中黑盒验证"的验收标准，输出严格 JSON：\n' +
        '{"pages":[{"route":"以/开头的页面路径","name":"页面名","description":"页面用途","expectedElements":[{"role":"button|link|textbox|combobox|checkbox|heading|img","name":"可见文案或标签"}]}],\n' +
        '"cases":[{"name":"用例名","source":"文档路径","quote":"文档原文<=80字","startRoute":"起始页面路径",\n' +
        '"steps":[{"action":"goto|click|fill|press|select|wait|check","by":"role|text|label|placeholder|selector","role":"button|link|textbox|combobox|checkbox|spinbutton(by=role时必填)","name":"目标元素名/URL/按键","value":"填充值/毫秒数(可空)","nth":0(同名元素索引,可选)}],\n' +
        '  注意：文档未给名字的同类输入框（如"两个数字输入框"）用 by=role + role=spinbutton/textbox + nth=0/1 区分，name 留空；\n' +
        '  涉及计算的用例必须写全：逐个 fill 输入 → click 触发按钮 → valueEquals/textVisible 断言结果。\n' +
        '"assertions":[{"type":"urlContains|textVisible|elementExists|elementMissing|valueEquals|noConsoleError","by":"text|role","role":"button等(可选)","expected":"期望文本/URL片段/数值"}]}]}\n' +
        '规则：\n' +
        '- 只提取文档明确描述且能在 UI 上验证的内容（页面、按钮、表单、点击效果、计算结果、跳转），纯后端接口不生成用例。\n' +
        '- 定位元素优先 by=role+name（如登录按钮），其次 by=text；禁止 CSS/XPath 选择器，除非文档直接给出。\n' +
        '- 文档中若给出具体示例数字（如"输入1+2应显示3"），必须生成 valueEquals 或 textVisible 断言带上该结果。\n' +
        '- 每个用例 steps 不超过 8 步；用例总数不超过 20 个；pages 不超过 15 个。\n' +
        '- expectedElements 只列文档明确提到的元素，不要臆造。',
    },
    { role: 'user', content: `以下是项目文档：\n\n${docsText}` },
  ];

  const stop = heartbeat(emit, 'Devin 正在提取验收标准');
  const raw = await chat({ model, messages }).finally(stop);
  const parsed = parseJson(raw);
  return {
    pages: (parsed.pages || []).slice(0, 15).map(p => ({
      route: String(p.route || '/'),
      name: String(p.name || p.route || '/'),
      description: String(p.description || ''),
      expectedElements: sanitizeElements(p.expectedElements),
    })),
    cases: (parsed.cases || []).slice(0, 20).map((c, i) => {
      const startRoute = String(c.startRoute || '/');
      const steps = sanitizeSteps(c.steps);
      // 执行器会自带起始导航，去掉与 startRoute 重复的首个 goto
      const first = steps[0];
      if (first?.action === 'goto' && (first.value || first.name) === startRoute) steps.shift();
      return {
        id: i + 1,
        name: String(c.name || `用例${i + 1}`),
        source: String(c.source || ''),
        quote: String(c.quote || ''),
        startRoute,
        steps,
        assertions: sanitizeAssertions(c.assertions),
      };
    }),
  };
}

/* -------------------- 本地启发式兜底 -------------------- */

const UI_WORDS = [
  [/按钮|button/i, 'button'], [/链接|link/i, 'link'],
  [/输入框|搜索框|文本框|input|textbox/i, 'textbox'],
  [/下拉|select|combobox/i, 'combobox'], [/复选|checkbox/i, 'checkbox'],
];

export function localTestPlan(docs) {
  const pages = new Map();
  const cases = [];
  let id = 1;
  let lastRoute = null;

  const ensurePage = r => {
    if (!pages.has(r)) pages.set(r, { route: r, name: r, description: '', expectedElements: [] });
    return pages.get(r);
  };

  for (const d of docs) {
    for (const line of d.content.split('\n')) {
      // 页面定义行：`- \`/calc\` 计算器：描述`，记住作为后续元素的归属页
      const def = line.match(/^\s*[-*]?\s*`(\/[a-zA-Z][\w/-]{0,40})`\s*[：:—\- ]?\s*(.*)/);
      if (def && !/\.(js|ts|css|png|md|json|html?)$/i.test(def[1])) {
        lastRoute = def[1];
        const pg = ensurePage(lastRoute);
        pg.name = (def[2].match(/^[^，。；,;]{1,30}/)?.[0] || lastRoute).replace(/[*_`]/g, '');
        pg.description = def[2];
      }
      // 行内其他路由
      for (const r of line.match(/(?<![\w/.])\/[a-zA-Z][\w/-]{0,40}(?![\w/])/g) || []) {
        if (!/\.(js|ts|css|png|md|json|html?)$/i.test(r)) ensurePage(r);
      }
      // 含 UI 词的行：提取其中所有「X」/"X"/`X` 作为预期元素名，
      // 角色取"名字之后最近的 UI 词"（如「首页」「关于」三个链接 → link）
      if (/(按钮|链接|输入框|搜索框|下拉框|复选框|button|link)/i.test(line)) {
        const words = [...line.matchAll(/按钮|链接|输入框|搜索框|下拉框|复选框|button|link/gi)]
          .map(m => ({ pos: m.index, role: (UI_WORDS.find(([re]) => re.test(m[0])) || [])[1] || 'button' }));
        const names = [...line.matchAll(/[「"`]([^「」"`\n]{1,15})[」"`]/g)]
          .map(m => ({ name: m[1].trim(), end: m.index + m[0].length }))
          .filter(n => n.name && !n.name.startsWith('/'));
        const page = (lastRoute && pages.get(lastRoute)) || ensurePage('/');
        for (const n of names) {
          const after = words.filter(w => w.pos >= n.end - 2);
          const w = (after.length ? after : words)
            .sort((a, b) => Math.abs(a.pos - n.end) - Math.abs(b.pos - n.end))[0];
          page.expectedElements.push({ role: w?.role || 'button', name: n.name });
        }
      }
    }
  }

  // 本地模式只生成"页面可访问 + 无 console 错误"的基础用例
  for (const p of pages.values()) {
    p.expectedElements = [...new Map(p.expectedElements.map(e => [e.role + e.name, e])).values()];
    cases.push({
      id: id++,
      name: `页面可访问：${p.route}`,
      source: '',
      quote: '',
      startRoute: p.route,
      steps: [],
      assertions: [{ type: 'noConsoleError', by: 'text', expected: '' },
        ...p.expectedElements.slice(0, 3).map(e => ({ type: 'elementExists', by: 'role', role: e.role, expected: e.name }))],
    });
  }
  return { pages: [...pages.values()], cases };
}
