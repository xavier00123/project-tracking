# Doc ↔ Code Diff Tracker

可视化检查"项目文档承诺的功能"与"实际实现"之间差异的工具，包含两条互补的管线：

- **静态分析**：文档功能点 ↔ 代码实现比对（implemented / partial / missing / uncertain）
- **动态验收测试**：启动/连接目标项目，用真实浏览器逐页巡检 + 执行交互用例，
  与文档对账得出 verified / divergent / missing / untestable，全程截图留证

## 工作原理（动态验收测试）

1. **连接目标**：填"已运行 URL"直接连；或填项目目录自动探测启动方式
   （`qa.config.json` > `package.json` 的 dev/start 脚本），spawn 进程并轮询端口就绪。
2. **提取验收标准**（Devin 模型）：从文档提取页面清单、预期元素、可执行用例
   （结构化步骤 goto/click/fill/press + 断言 urlContains/textVisible/valueEquals 等）。
3. **页面巡检**：Playwright 逐路由访问 → 截图 → aria snapshot 元素盘点 →
   与预期元素对账 → Devin 视觉复核截图（识别白屏、404、未实现提示等异常）。
4. **用例执行**：步骤由 Playwright 确定性执行（LLM 只出计划），
   role→label→placeholder→text 定位器兜底链容忍命名漂移；每步留截图。
5. **报告**：KPI、页面画廊（截图+元素清单+缺失标记）、用例表（预期 vs 真实结果+证据）、
   静态×动态按文档对账；历史结果存 `runs/` 可回看。

### 判定语义

| 状态 | 含义 |
|---|---|
| `verified` | 步骤全通且断言全过 |
| `divergent` | 页面可达但结果与文档不符（功能有但行为不对） |
| `missing` | 入口/页面本身不存在（404、导航失败） |
| `untestable` | 交互元素缺失，无法到达验证点 |

### qa.config.json（可选，放目标项目根目录）

```json
{
  "startCommand": "npm run dev",
  "port": 3000,
  "readyPath": "/",
  "env": { "NODE_ENV": "development" },
  "preSteps": [{"action": "fill", "by": "label", "name": "用户名", "value": "admin"}]
}
```

`preSteps` 在所有用例前执行一次（如登录）。

## 工作原理（静态分析）

1. **扫描**：遍历指定项目目录，分离文档（`.md`/`.rst` 等）与代码文件，并为代码建立符号索引（函数、类、路由等）。
2. **提取功能点**（Devin 模型阶段 1）：把文档内容发给 Devin 模型，提取结构化功能点清单（名称、描述、来源文档、检索关键词）。
3. **判定差异**（Devin 模型阶段 2）：按关键词为每个功能点找出候选代码文件，连同代码索引一起交给 Devin 模型判定 `implemented / partial / missing / uncertain` 并给出证据文件。
4. **可视化**：前端展示覆盖率、状态分布图、按文档统计、功能点明细表、"代码有但文档未写"的清单。

> 无需配置 API Key —— 直接复用本机 Devin CLI 的登录态（`devin -p` 非交互模式，含读图能力）。Devin CLI 未登录时可在页面切换"本地启发式"模式（精度较低，仅适合快速演示）。

## 启动

```bash
npm install
npm start          # http://localhost:3210
```

使用只需一步：填入目标项目目录，点「开始分析」。工具将依次执行
**静态代码比对 → 自动启动目标项目 → 浏览器页面巡检与交互验收 → 综合对账**。
启动方式自动探测（`qa.config.json` > `package.json` 脚本）；目标已在运行的话，
可在「⚙ 分析设置」里填"已运行 URL"跳过启动；也可勾选"只做静态分析"跳过动态测试。

## Devin 模型

首次使用需在终端执行一次登录：

```bash
devin auth login
```

页面"⚙ 分析设置"中可选填模型别名（如 `swe`、`opus`、`sonnet`），留空则跟随 Devin 的默认模型配置。

## 试用示例

仓库自带 `demo-app/`：一个故意"文档承诺多、实现少"的 express 小应用。
项目目录填 `demo-app` 的绝对路径，已运行 URL 留空即可自动启动——
会得到导航/计算等 verified、搜索/导出 CSV 等 divergent、设置页 missing 的报告。
