# Doc ↔ Code Diff Tracker

可视化检查"项目文档承诺的功能"与"实际代码实现"之间差异的工具。

## 工作原理

1. **扫描**：遍历指定项目目录，分离文档（`.md`/`.rst` 等）与代码文件，并为代码建立符号索引（函数、类、路由等）。
2. **提取功能点**（Devin 模型阶段 1）：把文档内容发给 Devin 模型，提取结构化功能点清单（名称、描述、来源文档、检索关键词）。
3. **判定差异**（Devin 模型阶段 2）：按关键词为每个功能点找出候选代码文件，连同代码索引一起交给 Devin 模型判定 `implemented / partial / missing / uncertain` 并给出证据文件。
4. **可视化**：前端展示覆盖率、状态分布图、按文档统计、功能点明细表、"代码有但文档未写"的清单。

> 无需配置 API Key —— 直接复用本机 Devin CLI 的登录态（`devin -p` 非交互模式）。Devin CLI 未登录时可在页面切换"本地启发式"模式（精度较低，仅适合快速演示）。

## 启动

```bash
npm install
npm start          # http://localhost:3210
```

## Devin 模型

首次使用需在终端执行一次登录：

```bash
devin auth login
```

页面"⚙ 分析设置"中可选填模型别名（如 `swe`、`opus`、`sonnet`），留空则跟随 Devin 的默认模型配置。

## 试用示例

页面中项目目录填入 `demo-project` 的绝对路径（如 `/Users/you/project-tracking/demo-project`），点击"开始分析"。该示例故意包含：已实现（登录/CRUD）、部分实现（搜索只匹配标题）、完全缺失（邮件提醒、CSV 导出、深色模式）等功能。
