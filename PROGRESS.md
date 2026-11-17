# 实现进度

> 第三方验收测试（Runtime QA）功能实施记录，对应 `PLAN.md`。全部完成。

## 状态总览

| 模块 | 状态 | 备注 |
|---|---|---|
| lib/browser.js | ✅ | playwright-core + channel:'chrome'（免下载浏览器）；截图 / aria snapshot 元素盘点 / console+网络错误捕获 |
| lib/runner.js | ✅ | URL 模式 + launch 模式（qa.config.json > package.json scripts）；stdout 端口解析 + 常用端口探测（排除预存在服务）；进程组清理已验证 |
| lib/cases.js | ✅ | devin 提取 pages+cases（step 含 role/nth、去重首跳）；local 启发式（角色按"名字后最近 UI 词"归属） |
| lib/execute.js | ✅ | 步骤确定性执行；role→label→placeholder→text→同角色 nth 兜底链；6 类断言 |
| lib/vision.js | ✅ | `devin -p` cwd=截图目录读 PNG；purpose / elements / expectedFound / expectedMissing / anomalies |
| lib/report.js / dyntest.js | ✅ | `runs/<id>/{report.json,shots/}`；主编排：连接→提取→巡检→用例→汇总；preSteps 支持 |
| server.js 接口 | ✅ | `POST /api/test`（SSE）、`POST /api/detect-launch`、`GET /api/runs`、`GET /api/runs/:id`、`/runs` 静态服务 |
| 前端（一键流程） | ✅ | 单个「开始分析」串行两阶段：静态分析 → 动态验收（自动探测启动、失败仅告警不影响静态结果）；可选项收进"分析设置"（URL覆盖/视觉开关/只做静态）；历史记录下拉在报告区 |
| demo-app | ✅ | `demo-app/`：express 4 页面 + docs 故意承诺未实现功能（深色模式/搜索/导出CSV/登录跳转） |
| e2e 验证 | ✅ | local + devin + launch 三模式全部实测通过（详见下方日志） |
| README 更新 | ✅ | |

## 判定语义（动态）

- `verified` 步骤全通 + 断言全过
- `divergent` 页面可达但结果与文档不符（含断言全失败）
- `missing` 入口/页面本身不存在（404、导航失败）
- `untestable` 交互元素缺失，到不了验证点

## 开发中发现并修复的问题

1. `sanitizeSteps` 丢失 `role` 字段 → 定位器兜底成 button 导致 click/fill 超时
2. LLM 首个 goto 步骤与执行器自动起始导航重复 → 已去重
3. 元素命名漂移（"数字输入框" vs 实际 "数字 A"）→ 定位器候选链 + `nth` + fill 类同角色兜底
4. 页面可达但断言全挂误报 missing → 调整为 divergent
5. launch 模式常用端口扫描命中本工具自身 3210 → spawn 前预探测已有服务并排除
6. **`chat()` 用 `spawnSync` 冻结整个 Node 事件循环** → LLM 调用期间服务器完全无响应（SSE 发不出、请求排队），表现为"卡住数分钟"且并发调用互踩 → 改异步 `spawn` + 每 15s 心跳（"已等待 Xs"）
7. **`parseJson` "第一个 `{` 到最后一个 `}`" 截取** → 模型输出含多个 JSON 块时跨块截取报语法错 → 改括号平衡提取第一个完整 JSON（容错：字符串内括号/转义/fence/尾随文字）
8. 选项联动：「只做静态分析」勾选时禁用 URL+视觉；local 模式禁用视觉复核
9. 进度加密：devinStatus 前提示、判定分批报"批次 x/n"、巡检报 HTTP 码/元素数/缺失数、LLM 调用注明"通常需 1-3 分钟"
10. **agent 动作实时可见**：`chat()` 加 `--export` ATIF 文件，`tailExport` 每 1.2s 轮询并流式提取完整 step（文件运行中不闭合，按括号平衡逐个解析），emit `🔧 工具调用` 和 `💭 推理叙述`；15s 心跳兜底思考空窗
11. **判定批次并发化**：judgeFeatures 按 3 路并发跑批（约 3x 提速），批次 emit 含功能点数/证据段数；顺带修复 undocumented 每批覆盖 → 跨批合并去重

## e2e 实测结果（demo-app）

- **local 模式**：5 页巡检（/settings、/dashboard 正确判 404 missing），3 verified / 2 missing
- **devin 模式（含视觉复核）**：5 页 × 截图语义分析（识别出 "Cannot GET" 白屏、登录未实现提示、无样式异常）；9 用例 → 4 verified（含 3+5=8 计算）、4 divergent（搜索/导出CSV/登录跳转/版本文案）、1 missing（/settings）、0 untestable
- **launch 模式**：自动 `npm run start` → stdout 解析出 4100 → 就绪 → 测试完成后进程组正确清理
- **前端**：完整报告页截图验证通过（KPI / 画廊 / 用例表 / 历史记录）

## 日志

- 2026-11-17：依赖 `playwright-core@1.65.1`；系统 Chrome 可用（channel:'chrome'）；实测 `devin -p` 可读 cwd 内 PNG → 视觉链路走 Devin 模型，零新增 API Key。
- 2026-11-17：全部功能实现并端到端验证完毕。
