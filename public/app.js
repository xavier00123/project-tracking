const $ = s => document.querySelector(s);

const STATUS_LABEL = { implemented: '已实现', partial: '部分实现', missing: '未实现', uncertain: '不确定' };
const STATUS_COLOR = { implemented: '#3ddc97', partial: '#ffc857', missing: '#ff7b8a', uncertain: '#8b93a7' };

let lastResult = null;
let currentFilter = 'all';
let charts = [];

// 恢复上次的输入
for (const id of ['projectDir', 'model', 'mode']) {
  const v = localStorage.getItem('dcdt.' + id);
  if (v) $('#' + id).value = v;
}

$('#toggleAdv').onclick = () => $('#advPanel').classList.toggle('hidden');

// Devin CLI 状态检测
(async () => {
  try {
    const s = await (await fetch('/api/llm-status')).json();
    const el = $('#devinStatus');
    if (!s.available) {
      el.textContent = '⚠ 未检测到 devin CLI，将不可用 Devin 模型（可选本地模式）';
      $('#model').placeholder = '仅 Devin 模式可用';
    } else if (!s.authed) {
      el.textContent = '⚠ devin CLI 未登录：请在终端运行 `devin auth login` 后再用 Devin 模式，或改用本地模式';
      el.style.color = '#ffc857';
      $('#model').placeholder = '需登录后可用';
    } else {
      el.textContent = `✓ Devin CLI 就绪（${s.detail || '已登录'}）`;
      el.style.color = '#3ddc97';
      const mi = $('#model');
      if (s.defaultModel) mi.placeholder = `默认：${s.defaultModel}`;
      if (s.models?.length) $('#modelList').innerHTML =
        s.models.map(m => `<option value="${m}">`).join('');
    }
  } catch {
    $('#devinStatus').textContent = 'Devin CLI 状态检测失败';
  }
})();

$('#pickBtn').onclick = async () => {
  $('#pickBtn').disabled = true;
  try {
    const res = await fetch('/api/pick-dir', { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!data.cancelled && data.path) {
      $('#projectDir').value = data.path;
      localStorage.setItem('dcdt.projectDir', data.path);
    }
  } catch (e) {
    alert('目录选择失败：' + e.message + '\n请手动输入路径。');
  } finally {
    $('#pickBtn').disabled = false;
  }
};

$('#scanBtn').onclick = async () => {
  const projectDir = $('#projectDir').value.trim();
  if (!projectDir) return alert('请先填写项目目录');
  localStorage.setItem('dcdt.projectDir', projectDir);
  $('#scanInfo').textContent = '扫描中…';
  try {
    const res = await fetch('/api/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    $('#scanInfo').textContent = `发现 ${data.docCount} 个文档、${data.codeFileCount} 个代码文件`;
  } catch (e) {
    $('#scanInfo').textContent = '扫描失败：' + e.message;
  }
};

$('#analyzeBtn').onclick = async () => {
  const projectDir = $('#projectDir').value.trim();
  if (!projectDir) return alert('请先填写项目目录');
  for (const id of ['projectDir', 'model', 'mode']) {
    localStorage.setItem('dcdt.' + id, $('#' + id).value.trim());
  }

  $('#analyzeBtn').disabled = true;
  $('#progressCard').classList.remove('hidden');
  $('#resultCard').classList.add('hidden');
  $('#progressLog').innerHTML = '';
  log('开始分析…');

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectDir,
        mode: $('#mode').value,
        model: $('#model').value.trim() || undefined,
      }),
    });
    await readSSE(res, (event, data) => {
      if (event === 'progress') log(data.msg);
      else if (event === 'error') { log('错误：' + data.error, true); }
      else if (event === 'result') renderResult(data);
    });
  } catch (e) {
    log('请求失败：' + e.message, true);
  } finally {
    $('#analyzeBtn').disabled = false;
  }
};

function log(msg, isErr) {
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  if (isErr) li.classList.add('err');
  $('#progressLog').appendChild(li);
  li.scrollIntoView();
}

async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let event = 'message', data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) {
        try { onEvent(event, JSON.parse(data)); }
        catch (e) { console.error('SSE JSON parse error:', data, e); }
      }
    }
  }
}

function renderResult(r) {
  lastResult = r;
  const s = r.summary;
  $('#resultCard').classList.remove('hidden');
  $('#kpiCoverage').textContent = s.coverage + '%';
  $('#kpiImpl').textContent = s.implemented;
  $('#kpiPartial').textContent = s.partial;
  $('#kpiMissing').textContent = s.missing;
  $('#kpiUncertain').textContent = s.uncertain;
  $('#metaInfo').textContent =
    `项目：${r.project} · 模式：${r.mode === 'devin' ? 'Devin 模型分析' : '本地启发式'} · ` +
    `${s.docCount} 个文档 / ${s.codeFileCount} 个代码文件 · ${new Date(r.analyzedAt).toLocaleString()}`;

  renderCharts(r);
  renderTable(r.features);
  renderUndoc(r.undocumented);
  $('#resultCard').scrollIntoView({ behavior: 'smooth' });
}

function renderCharts(r) {
  charts.forEach(c => c.dispose());
  charts = [];
  if (typeof echarts === 'undefined') return;

  const s = r.summary;
  const pie = echarts.init($('#chartStatus'), null, { renderer: 'canvas' });
  pie.setOption({
    backgroundColor: 'transparent',
    title: { text: '功能实现状态分布', textStyle: { color: '#c6cde0', fontSize: 14 }, left: 'center' },
    tooltip: { trigger: 'item' },
    series: [{
      type: 'pie', radius: ['45%', '70%'],
      label: { color: '#c6cde0' },
      data: [
        { name: '已实现', value: s.implemented, itemStyle: { color: STATUS_COLOR.implemented } },
        { name: '部分实现', value: s.partial, itemStyle: { color: STATUS_COLOR.partial } },
        { name: '未实现', value: s.missing, itemStyle: { color: STATUS_COLOR.missing } },
        { name: '不确定', value: s.uncertain, itemStyle: { color: STATUS_COLOR.uncertain } },
      ],
    }],
  });
  charts.push(pie);

  // 按来源文档统计
  const byDoc = {};
  for (const f of r.features) {
    const d = f.source || '(未知)';
    byDoc[d] = byDoc[d] || { implemented: 0, partial: 0, missing: 0, uncertain: 0 };
    byDoc[d][f.status] = (byDoc[d][f.status] || 0) + 1;
  }
  const docs = Object.keys(byDoc);
  const bar = echarts.init($('#chartByDoc'));
  bar.setOption({
    backgroundColor: 'transparent',
    title: { text: '各文档功能实现情况', textStyle: { color: '#c6cde0', fontSize: 14 }, left: 'center' },
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0, textStyle: { color: '#8b93a7' } },
    xAxis: { type: 'category', data: docs.map(d => d.length > 24 ? '…' + d.slice(-24) : d), axisLabel: { color: '#8b93a7', rotate: 20 } },
    yAxis: { type: 'value', axisLabel: { color: '#8b93a7' }, splitLine: { lineStyle: { color: '#262e44' } } },
    series: [
      { name: '已实现', type: 'bar', stack: 'x', data: docs.map(d => byDoc[d].implemented), itemStyle: { color: STATUS_COLOR.implemented } },
      { name: '部分实现', type: 'bar', stack: 'x', data: docs.map(d => byDoc[d].partial), itemStyle: { color: STATUS_COLOR.partial } },
      { name: '未实现', type: 'bar', stack: 'x', data: docs.map(d => byDoc[d].missing), itemStyle: { color: STATUS_COLOR.missing } },
      { name: '不确定', type: 'bar', stack: 'x', data: docs.map(d => byDoc[d].uncertain), itemStyle: { color: STATUS_COLOR.uncertain } },
    ],
  });
  charts.push(bar);
}

function renderTable(features) {
  const tbody = $('#featureTable tbody');
  tbody.innerHTML = '';
  for (const f of features) {
    if (currentFilter !== 'all' && f.status !== currentFilter) continue;
    const tr = document.createElement('tr');
    const ev = (f.evidence || []).map(e =>
      `<div>📄 ${escapeHtml(e.file)}${e.note ? ' — ' + escapeHtml(e.note) : ''}</div>`).join('');
    tr.innerHTML =
      `<td><div class="fname">${escapeHtml(f.name)}</div>` +
      (f.description ? `<div class="fdesc">${escapeHtml(f.description)}</div>` : '') +
      (f.quote ? `<div class="fquote">"${escapeHtml(f.quote)}"</div>` : '') + `</td>` +
      `<td class="evidence">${escapeHtml(f.source || '-')}</td>` +
      `<td><span class="badge ${f.status}">${STATUS_LABEL[f.status] || f.status}</span></td>` +
      `<td>${Math.round((f.confidence || 0) * 100)}%</td>` +
      `<td class="evidence">${ev || '<span class="muted">无</span>'}</td>` +
      `<td>${escapeHtml(f.note || '')}</td>`;
    tbody.appendChild(tr);
  }
}

function renderUndoc(list) {
  const card = $('#undocCard');
  const ul = $('#undocList');
  ul.innerHTML = '';
  if (!list || !list.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  for (const u of list) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="fname">${escapeHtml(u.name)}</span>` +
      (u.files?.length ? `<div class="files">${u.files.map(escapeHtml).join(', ')}</div>` : '');
    ul.appendChild(li);
  }
}

$('#filters').addEventListener('click', e => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  document.querySelectorAll('#filters .chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  currentFilter = btn.dataset.f;
  if (lastResult) renderTable(lastResult.features);
});

window.addEventListener('resize', () => charts.forEach(c => c.resize()));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
