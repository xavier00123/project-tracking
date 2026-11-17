import { chat, parseJson, heartbeat } from './llm.js';

/**
 * 截图语义分析：把 devin CLI 的 cwd 指到截图目录，
 * agent 用自己的文件读取工具看 PNG（已实测可行）。
 * 注意：每次调用是一次完整 agent session，只做复核/语义层判断，
 * 元素盘点主链路仍走 aria snapshot（确定性、零成本）。
 */

/**
 * 分析单张截图的 UI 元素与页面用途。
 * @param {string} shotsDir 截图目录绝对路径
 * @param {string} file 截图文件名
 * @param {object} opts { model?, expectedElements? }
 * @returns {Promise<{purpose, elements:[{role,name}], expectedFound:[], expectedMissing:[], anomalies:[]}>}
 */
export async function analyzeScreenshot(shotsDir, file, opts = {}) {
  const { model, expectedElements = [] } = opts;
  const expectList = expectedElements.length
    ? `\n文档预期该页面应包含这些元素：${expectedElements.map(e => `${e.role}"${e.name}"`).join('、')}。请逐项核对是否真的出现在截图里。`
    : '';

  const messages = [
    {
      role: 'system',
      content:
        '你是 UI 验收测试分析师。用文件读取工具打开当前目录中的指定截图（PNG），仔细观察后输出严格 JSON：\n' +
        '{"purpose":"一句话说明页面用途","elements":[{"role":"button|link|textbox|combobox|checkbox|heading|navigation|table|form|img","name":"元素上的可见文案"}],' +
        '"expectedFound":["在预期清单中且确实出现的元素名"],"expectedMissing":["在预期清单中但截图里看不到的元素名"],' +
        '"anomalies":["明显的视觉/内容异常：白屏、报错堆栈、布局错乱、404提示等，没有则为空数组"]}\n' +
        '只报告截图中真实可见的内容，不要推测被遮挡或未加载的部分。',
    },
    { role: 'user', content: `请读取并分析当前目录下的截图文件：${file}${expectList}` },
  ];

  const stop = heartbeat(opts.emit, `Devin 正在读图 ${file}`);
  const raw = await chat({ model, messages, cwd: shotsDir, timeoutMs: 300_000 }).finally(stop);
  const parsed = parseJson(raw);
  return {
    purpose: String(parsed.purpose || ''),
    elements: Array.isArray(parsed.elements) ? parsed.elements.slice(0, 60).map(e => ({
      role: String(e.role || '').toLowerCase(),
      name: String(e.name || ''),
    })) : [],
    expectedFound: Array.isArray(parsed.expectedFound) ? parsed.expectedFound.map(String) : [],
    expectedMissing: Array.isArray(parsed.expectedMissing) ? parsed.expectedMissing.map(String) : [],
    anomalies: Array.isArray(parsed.anomalies) ? parsed.anomalies.map(String) : [],
  };
}
