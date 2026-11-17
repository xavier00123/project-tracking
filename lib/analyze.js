import { scanProject, readCodeFile } from './scanner.js';
import { buildCodeIndex, findCandidateFiles, renderIndexText, keywordsOf } from './codeindex.js';
import { chat, parseJson } from './llm.js';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FEATURES_PER_BATCH = 15;
const MAX_EXCERPT_CHARS = 3000;
const MAX_EXCERPTS_PER_FEATURE = 5;

/**
 * 阶段一：从文档中提取功能点清单
 */
async function extractFeaturesFromDocs(docs, model, emit) {
  const docsText = docs
    .map(d => `===== 文档: ${d.path} =====\n${d.content}`)
    .join('\n\n')
    .slice(0, 80_000);

  const messages = [
    {
      role: 'system',
      content:
        '你是软件项目分析助手。从项目文档中提取"文档承诺的功能点"清单。' +
        '只提取文档中明确描述的功能/特性/接口/命令/页面能力，不要编造。' +
        '输出 JSON：{"features":[{"name":"简短功能名","description":"一句话描述","source":"文档路径","quote":"文档原文片段(<=80字)","keywords":["用于在代码中检索的关键词2-5个,中英文均可"]}]}',
    },
    { role: 'user', content: `以下是项目的全部文档内容：\n\n${docsText}` },
  ];
  emit?.(`送入 ${docs.length} 篇文档（共 ${docsText.length} 字符），等待 Devin 提取…`);
  const raw = await chat({ model, messages, emit });
  const parsed = parseJson(raw);
  return (parsed.features || []).map((f, i) => ({
    id: i + 1,
    name: String(f.name || `功能${i + 1}`),
    description: String(f.description || ''),
    source: String(f.source || ''),
    quote: String(f.quote || ''),
    keywords: Array.isArray(f.keywords) ? f.keywords.map(String) : keywordsOf(f.name + ' ' + (f.description || '')),
  }));
}

/**
 * 阶段二：结合代码索引与候选文件内容，判定每个功能点的实现状态
 */

/** 单批判定：检索证据 → LLM 判定，返回 {judgements, undocumented} */
async function judgeBatch(batch, batchNo, indexText, index, root, model, emit) {
  let excerptFiles = 0;
  const evidenceBlocks = batch.map(f => {
    const candidates = findCandidateFiles(index, [...f.keywords, ...keywordsOf(f.name)], MAX_EXCERPTS_PER_FEATURE);
    excerptFiles += candidates.length;
    const excerpts = candidates
      .map(p => {
        const c = readCodeFile(root, p, MAX_EXCERPT_CHARS);
        return c ? `--- ${p} ---\n${c}` : null;
      })
      .filter(Boolean)
      .join('\n\n');
    return `##### 功能 #${f.id}: ${f.name}\n描述: ${f.description}\n候选代码文件:\n${excerpts || '(未找到明显相关的代码文件)'}`;
  });
  emit?.(`批次 ${batchNo}：${batch.length} 个功能点、${excerptFiles} 段候选代码，等待 Devin 判定…`);

  const messages = [
    {
      role: 'system',
      content:
        '你是严格的软件项目审计助手。给定文档功能点、项目代码文件索引、以及每个功能点可能相关的代码文件内容，' +
        '判断每个功能在实际代码中的实现程度，采取从严标准：\n' +
        '- implemented：提供的代码片段中必须能直接看到该功能的实际实现（函数体、路由处理逻辑、页面渲染等），' +
        '且 evidence 必须指出实现它的具体函数名、路由或符号。仅文件名相似、仅有类型/接口定义、' +
        '仅在别处被调用或引用，均不得判为 implemented。\n' +
        '- partial：只有骨架、TODO、接口定义或部分逻辑。\n' +
        '- missing：在候选代码与索引中找不到实现证据。\n' +
        '- uncertain：候选片段不足以判断。\n' +
        '拿不准时一律选更保守的状态；禁止凭命名相似或常识推断实现。\n' +
        'evidence 中只引用候选代码或索引中真实出现的文件路径。输出 JSON：\n' +
        '{"judgements":[{"id":1,"status":"implemented|partial|missing|uncertain","confidence":0-1,"evidence":[{"file":"相对路径","note":"证据说明<=40字"}],"note":"总体说明<=80字"}],' +
        '"undocumented":[{"name":"代码中有但文档未提及的明显功能","files":["路径"]}]}',
    },
    {
      role: 'user',
      content:
        `【项目代码索引(文件 -> 符号)】\n${indexText}\n\n` +
        `【待判定功能点及相关代码】\n${evidenceBlocks.join('\n\n')}\n\n` +
        `另外请根据代码索引列出最多8个"代码中明显存在但文档未覆盖"的功能点放入 undocumented。`,
    },
  ];

  // 模型偶尔会输出带杂散的 JSON——解析失败重试一次；仍失败则整批降级，
  // 不拖垮其他批次（缺失判定的功能点会落到 uncertain）
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await chat({ model, messages, emit });
      emit?.(`批次 ${batchNo} 判定完成`);
      return parseJson(raw);
    } catch (e) {
      lastErr = e;
      const isParse = /解析模型 JSON|JSON/i.test(e.message);
      emit?.(`批次 ${batchNo} ${isParse ? '输出解析失败' : '调用失败'}：` +
        `${e.message.slice(0, 120)}${attempt === 1 ? '，重试…' : '，放弃本批'}`);
      if (attempt === 2 || !isParse) break;
    }
  }
  return { judgements: [], undocumented: [], batchError: lastErr?.message };
}

const JUDGE_CONCURRENCY = 3;

async function judgeFeatures(features, index, root, model, emit) {
  const indexText = renderIndexText(index);
  const results = [];
  const undocumented = [];

  const batches = [];
  for (let i = 0; i < features.length; i += FEATURES_PER_BATCH) {
    batches.push(features.slice(i, i + FEATURES_PER_BATCH));
  }
  let done = 0;
  // 并发 3 路跑批：批次间互相独立，进度也更有"活着"的感觉
  for (let w = 0; w < batches.length; w += JUDGE_CONCURRENCY) {
    const wave = batches.slice(w, w + JUDGE_CONCURRENCY);
    const outs = await Promise.all(wave.map((batch, k) =>
      judgeBatch(batch, w + k + 1, indexText, index, root, model, emit)));
    for (const parsed of outs) {
      results.push(...(parsed.judgements || []));
      for (const u of parsed.undocumented || []) {
        if (!undocumented.some(x => x.name === u.name)) undocumented.push(u);
      }
    }
    done += wave.reduce((n, b) => n + b.length, 0);
    emit?.(`判定进度 ${done}/${features.length}`);
  }
  results._undocumented = undocumented;
  return results;
}

/* -------------------- 无 LLM 的本地启发式兜底 -------------------- */

function localExtractFeatures(docs) {
  const features = [];
  let id = 1;
  for (const d of docs) {
    const lines = d.content.split('\n');
    for (const line of lines) {
      // 形如 `- \`POST /api/x\` — 描述` 的接口条目：路径是强检索关键词
      const api = line.match(/^\s*[-*]\s+`([A-Z]+\s+\/[^`\s]+)`\s*[—\-:：]?\s*(.*)/);
      if (api) {
        const [method, apiPath] = api[1].split(/\s+/, 2);
        const segs = api[1].split(/[\s/]+/).filter(s => s && !s.startsWith(':'));
        features.push({
          id: id++,
          name: `接口 ${api[1]}`,
          description: api[2].trim().slice(0, 120),
          source: d.path,
          quote: line.trim().slice(0, 80),
          method: method ? method.toLowerCase() : '',
          apiPath: (apiPath || '').replace(/\{[^}]*\}/g, m => ':' + m.slice(1, -1)),
          keywords: [...segs, ...keywordsOf(api[2])],
        });
        continue;
      }
      const h = line.match(/^#{2,4}\s+(.+)/) || line.match(/^\s*[-*]\s+\*\*(.+?)\*\*[:：]?\s*(.*)/);
      if (h) {
        const name = h[1].replace(/[*`]/g, '').trim().slice(0, 60);
        if (name && name.length >= 2 && !/^(功能特性|特性|功能|features?)$/i.test(name)) {
          features.push({
            id: id++,
            name,
            description: (h[2] || '').trim().slice(0, 120),
            source: d.path,
            quote: line.trim().slice(0, 80),
            keywords: keywordsOf(name + ' ' + (h[2] || '')),
          });
        }
      }
      if (features.length >= 60) return features;
    }
  }
  return features;
}

const GENERIC_KW = new Set([
  'get', 'post', 'put', 'delete', 'patch', 'api', 'id',
  // 语言关键字，避免误匹配（如 export 撞上 JS 的 export 关键字）
  'export', 'import', 'default', 'const', 'let', 'var', 'function', 'class',
  'return', 'require', 'module', 'async', 'await', 'new', 'this', 'def', 'fn',
]);

function localJudge(features, index) {
  const judgements = features.map(f => {
    const allKw = [...f.keywords, ...keywordsOf(f.name)].map(k => k.toLowerCase());
    const meaningful = allKw.filter(k => k.length >= 2 && !GENERIC_KW.has(k));
    let status = 'missing';
    let note = '';
    let hitFiles = [];

    if (f.apiPath) {
      // API 功能点：优先匹配 method 与 path 在同行/邻近出现，避免仅路径名命中 GET 却判定 POST
      const routeRe = f.method
        ? new RegExp(`\\b${escapeRegExp(f.method)}\\b[^\\n]{0,80}${escapeRegExp(f.apiPath)}(?![A-Za-z0-9_\\\\/])`, 'i')
        : new RegExp(escapeRegExp(f.apiPath), 'i');
      const full = index.filter(fi => routeRe.test(fi.content || ''));
      if (full.length) {
        status = 'implemented';
        note = `路由 "${f.apiPath}" 在代码中存在`;
        hitFiles = full.map(fi => fi.path);
      } else {
        // 完整路径不存在：检查最后一个静态路径段（最具区分度）
        const staticSegs = f.apiPath.split('/').filter(s => s && !s.startsWith(':'));
        const tail = staticSegs[staticSegs.length - 1];
        const hit = tail && !GENERIC_KW.has(tail.toLowerCase()) && index.filter(fi =>
          (fi.path + '\n' + fi.symbols.join('\n') + '\n' + (fi.content || '')).toLowerCase()
            .includes(tail.toLowerCase()));
        if (hit && hit.length && tail !== staticSegs[0]) {
          status = 'partial';
          note = `路径 "${f.apiPath}" 未精确匹配，但片段 "${tail}" 出现`;
          hitFiles = hit.map(fi => fi.path);
        } else {
          note = `路由 "${f.apiPath}" 未在代码中找到`;
        }
      }
    } else {
      // 普通功能点：锚点关键词规则（优先可匹配的 ASCII 词）
      const ascii = meaningful.filter(k => /^[a-z0-9_.-]+$/i.test(k));
      const anchor = (ascii.length ? ascii : meaningful).sort((a, b) => b.length - a.length)[0];
      if (anchor) {
        const hit = index.filter(fi =>
          (fi.path + '\n' + fi.symbols.join('\n') + '\n' + (fi.content || '')).toLowerCase().includes(anchor)
        );
        if (hit.length) {
          // 从严：≥2 个关键词必须在同一文件的符号/内容中共现（路径命中不算），
          // 防止关键词散落在不同文件而误判为已实现
          const scored = hit.map(fi => {
            const body = (fi.symbols.join('\n') + '\n' + (fi.content || '')).toLowerCase();
            return { path: fi.path, n: meaningful.filter(k => body.includes(k)).length };
          });
          const strong = scored.filter(s => s.n >= 2);
          if (strong.length) {
            status = 'implemented';
            hitFiles = strong.map(s => s.path);
            note = '同一文件内多个关键词共现';
          } else {
            status = 'partial';
            hitFiles = hit.map(fi => fi.path);
            note = `仅锚点关键词 "${anchor}" 命中，无同文件佐证`;
          }
        } else {
          note = `锚点关键词 "${anchor}" 未在代码中出现`;
        }
      } else {
        note = '无可检索关键词';
      }
    }

    return {
      id: f.id, status,
      confidence: status === 'missing' ? 0.6 : 0.4,
      evidence: status === 'missing' ? [] : hitFiles.slice(0, 3).map(p => ({ file: p, note: '关键词匹配' })),
      note,
    };
  });
  judgements._undocumented = [];
  return judgements;
}

/* -------------------- 主入口 -------------------- */

/**
 * @param {object} opts { projectDir, mode: 'devin'|'local', model?: string, emit }
 */
export async function analyzeProject(opts) {
  const { projectDir, mode = 'devin', model, emit } = opts;
  const useLLM = mode === 'devin';

  emit?.('扫描项目目录…');
  const { root, docs, codeFiles } = scanProject(projectDir);
  emit?.(`发现 ${docs.length} 个文档、${codeFiles.length} 个代码文件`);

  const index = buildCodeIndex(root, codeFiles);

  let features;
  if (useLLM) {
    emit?.(`阶段 1/2：Devin 模型从文档提取功能点${model ? `（${model}）` : ''}（通常需 1-3 分钟）…`);
    features = await extractFeaturesFromDocs(docs, model, emit);
  } else {
    emit?.('本地模式：从文档标题/列表提取功能点…');
    features = localExtractFeatures(docs);
  }
  emit?.(`提取到 ${features.length} 个文档功能点`);

  let judgements;
  if (useLLM) {
    emit?.('阶段 2/2：Devin 模型比对代码判定实现状态…');
    judgements = await judgeFeatures(features, index, root, model, emit);
  } else {
    emit?.('本地模式：关键词匹配判定…');
    judgements = localJudge(features, index);
  }

  const undocumented = judgements._undocumented || [];
  const byId = new Map(judgements.map(j => [j.id, j]));
  const merged = features.map(f => {
    const j = byId.get(f.id) || { status: 'uncertain', confidence: 0, evidence: [], note: '未返回判定' };
    return { ...f, status: j.status, confidence: j.confidence ?? 0, evidence: j.evidence || [], note: j.note || '' };
  });

  const counts = { implemented: 0, partial: 0, missing: 0, uncertain: 0 };
  for (const f of merged) counts[f.status] = (counts[f.status] || 0) + 1;
  const scored = counts.implemented + counts.partial * 0.5;
  const coverage = merged.length ? Math.round((scored / merged.length) * 1000) / 10 : 0;

  return {
    project: root,
    analyzedAt: new Date().toISOString(),
    mode: useLLM ? 'devin' : 'local',
    summary: {
      docCount: docs.length,
      codeFileCount: codeFiles.length,
      featuresTotal: merged.length,
      ...counts,
      coverage,
    },
    features: merged,
    undocumented: Array.isArray(undocumented) ? undocumented.slice(0, 10) : [],
  };
}
