# 第三方验收测试（Runtime QA）实施计划

> 在现有「文档 ↔ 代码静态差异分析」之上，新增**动态验收测试**能力：
> 启动目标项目 → 打开页面 → 截图 + 元素盘点 → 执行交互 → 记录真实结果 → 与文档对账。
> **静态分析模式保留**，与动态结果合并出综合报告；LLM 统一走 Devin 模型
> （已实测：`devin -p` 模式下 agent 可直接读取 cwd 中的 PNG 截图，视觉分析可行）。

## 1. 目标定位

把「文档承诺了什么」和「产品跑起来实际是什么样」对齐：

| 维度 | 产出 |
|---|---|
| 页面 | 文档提到的每个路由/页面是否真实存在、能否打开 |
| 元素 | 页面实际有哪些按钮/表单/链接（截图 + 结构化清单） |
| 功能 | 每个文档功能点：预期行为 vs 实际行为 |
| 交互 | 点击/填表后：预期页面/逻辑/计算结果 vs 真实结果 |
| 结论 | `verified`（与文档一致）/ `divergent`（有实现但不符）/ `missing` / `untestable` |

## 2. 可复用的现有资产

- `lib/scanner.js` — 项目目录扫描、文档/代码分离
- `lib/analyze.js` 阶段一 — 从文档提取功能点（prompt 需升级为提取「可测试验收标准」）
- `lib/llm.js` — devin CLI 非交互调用（文本模型已就绪）
- `server.js` — SSE 流式进度模式，新接口照抄 `/api/analyze` 即可
- `public/` — 仪表盘骨架、状态徽章、筛选、ECharts

## 3. 总体架构

```
┌────────────┐   ┌──────────────┐   ┌───────────────┐   ┌─────────────┐
│ docs 提取   │ → │ 启动/连接目标 │ → │ 浏览器巡检+交互 │ → │ 判定+报告    │
│ 验收标准    │   │ (runner)     │   │ (playwright)  │   │ (judge)     │
└────────────┘   └──────────────┘   └───────────────┘   └─────────────┘
      LLM 文本          进程管理           截图/ARIA/日志        LLM + 证据
```

### 模块拆分（新增）

| 模块 | 职责 |
|---|---|
| `lib/runner.js` | 启动目标项目：探测启动方式（package.json scripts / 用户指定命令 / 已在跑的 URL），spawn 进程、轮询端口就绪、结束后清理子进程 |
| `lib/browser.js` | Playwright 封装：启动 Chromium、访问页面、截图、`page.accessibility` / aria snapshot 元素盘点、console/network 错误捕获 |
| `lib/cases.js` | 把文档功能点转成「测试用例」：目标页面、预期元素、操作步骤（LLM 输出结构化 JSON：goto/click/fill/assert）、预期结果断言 |
| `lib/execute.js` | 确定性执行测试步骤（LLM 只出计划，Playwright 负责执行），收集每步证据：前后截图、URL 变化、出现的文本、计算值、console 错误 |
| `lib/report.js` | 结果模型 + 持久化：`runs/<id>/` 存截图与 JSON，供历史对比和前端展示 |
| `lib/judge.js` | 汇总页面巡检 + 交互结果，与文档断言比对出 verified/divergent/missing；证据链落到截图和日志 |
| `lib/vision.js` | 截图语义分析：`devin -p` 的 cwd 设为 `runs/<id>/shots/`，prompt 中引用 PNG 文件名让 agent 读取图片（已实测可行），用于识别按钮语义、视觉异常复核 |

### server.js 新增接口

- `POST /api/test` — SSE 流式跑动态测试（复用现有 SSE 模式）
- `GET /api/runs` / `GET /api/runs/:id` — 历史记录
- `GET /runs/:id/shots/xxx.png` — 静态服务截图目录

## 4. 核心流程设计

1. **连接目标**（两种入口）
   - 用户填「已运行 URL」→ 直接用（逃生舱，推荐 MVP 先做）
   - 用户填项目目录 → 探测 `package.json` 的 `dev/start`、或读可选配置 `qa.config.json`（startCommand / port / env / readyPath）→ spawn + 轮询端口
2. **文档提取 v2**：LLM 输出 `{pages:[{route, expectedElements[]}], cases:[{name, source, steps[], expected}]}`
   - 断言类型：`urlChanged`、`textVisible`、`elementExists`、`valueEquals`（计算结果）、`noConsoleError`
3. **页面巡检**：每个路由访问 → 截图 → aria snapshot → 产出「实际元素清单」→ 与 expectedElements 对账
4. **交互执行**：逐步执行 steps，每步记录 before/after 截图 + 断言真实结果
5. **合并报告**：静态分析结果（已实现/缺失）与动态结果（验证通过/不符）合并成一张表；
   「代码有实现但 UI 找不到」= divergent 重点线索，「代码没有且 UI 没有」= missing 双确认

## 5. 数据模型（结果）

```js
{
  runId, targetUrl, startedAt, mode: 'url'|'launch',
  pages: [{ route, ok, screenshot, elements: [{role,name,tag}], missingExpected, unexpected }],
  cases: [{ name, source, expected, steps: [{action, ok, shot, actual}], status: 'verified|divergent|missing|untestable', evidence }],
  summary: { pagesOk, verified, divergent, missing, coverage }
}
```

## 6. 需要的资源与依赖

| 资源 | 说明 | 风险/备选 |
|---|---|---|
| `playwright` npm 依赖 | 浏览器自动化核心，需下载 Chromium（~120MB） | 可用 `playwright-core` + `channel:'chrome'` 复用系统 Chrome，免下载 |
| 视觉/文本 LLM | 提取验收标准、生成测试步骤、截图语义分析、判定结果 | **统一用 Devin 模型**：`devin -p` cwd 指向截图目录即可读图（已实测）；零新增 API Key |
| 目标项目运行时 | 目标自身的 node/python/DB 等 | 超出本工具范围 → 「已运行 URL」模式规避 |
| 存储 | `runs/` 目录（.gitignore），JSON + PNG | 无需数据库 |
| Node ≥ 18 | Playwright 要求 | 已满足 |

## 7. 前端改造

- 配置区新增：目标 URL（或项目目录 + 启动命令）、动态测试开关
- 结果区新增：
  - 页面清单（路由 → 截图缩略图 + 实际元素 vs 预期元素 diff）
  - 用例表（预期结果 / 实际结果 / 状态 / 证据截图点击放大）
  - 步骤时间线（每步 shot + 断言结果）
- 与现有静态报告并存为两个 Tab，或加「综合覆盖率」KPI

## 8. 分阶段实施

- **Phase 1（MVP）**：已运行 URL 模式 + 页面巡检（截图 + aria 元素盘点 + devin 视觉复核 + expectedElements 对账）+ 报告页面。不含交互。
- **Phase 2**：LLM 生成结构化步骤 → Playwright 执行 → 断言（URL/文本/元素/console）→ verified/divergent 判定；与静态分析报告合并出综合覆盖率。
- **Phase 3**：计算结果校验（docs 中的示例数字 → DOM 值比对）、历史 run 对比回归。
- **Phase 4**：自动启动项目（runner.js 完整版）、多页面流程编排（登录→操作→断言）。

## 9. 风险与开放问题

1. ~~devin CLI 是否支持图片输入~~ **已解决**：`devin -p` 在 cwd 为截图目录时可读取 PNG（实测正确识别色块布局与像素尺寸）。注意每次视觉调用是一次完整 agent session，成本高于纯文本，元素盘点仍走 aria snapshot，视觉只做复核与语义识别。
2. **选择器稳定性**——统一用 Playwright role/text 定位器，LLM 计划里禁止 CSS 选择器。
3. **目标项目启动复杂性**——构建、env、依赖服务等不可控，所以「已运行 URL」必须是正式功能而非临时方案。
4. **登录/权限页面**——需要可配置的 pre-steps（如先填表登录），Phase 4 处理。
5. **误报率**——动态判定比静态更容易受时序影响，所有断言结果必须带截图证据，允许人工复核标记。
