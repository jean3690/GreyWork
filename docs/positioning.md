# GreyWork 定位：Claude Code × Pi 的折中

> 状态：2026-08-27 确立。本文是定位总纲，架构见 `architecture.md`，视觉与交互见 `ui-design.md`。

## 一句话定位

**GreyWork = Claude Code 的执行力 + Pi 的可视化与亲和力 —— 一个能「看得见 Agent 在工作」的桌面 AI 协同工作台。**

Claude Code 是终端里的自主工程师：强、快、但对非终端用户不友好，过程不可见。Pi（Inflection）是图形化、有温度、好上手的对话助手：亲和，但缺少对工程化、文件、命令、多 Agent 编排的底层掌控。GreyWork 取二者之长，补二者之短。

```
Claude Code ──(强执行 / 弱可视化)──►  GreyWork  ◄──(弱工程掌控 / 强可视化)── Pi
   终端原生、自主循环              看得见、管得住、可装插件            图形优先、对话亲和
```

## 折中到底「折」在哪

| 维度 | Claude Code（对标一端） | **GreyWork（折中）** | Pi（对标另一端） |
| --- | --- | --- | --- |
| 形态 | 纯终端 / CLI | Tauri 桌面 GUI + 终端视图 | 网页 / App 聊天 |
| 工程能力 | 直接读写文件、跑命令、Git | 直接读写文件、跑命令、Git（经命令守卫） | 基本无 |
| Agent 可见性 | 滚动日志，过程隐于终端 | 多 Agent 看板、状态灯、进度条、轨道环 | 单条气泡，看不到编排 |
| 多 Agent | 单 agent 自主循环 | 规划→研究→执行→审查 并行编排（`@greywork/agents`） | 单 agent |
| 上手门槛 | 需懂终端 | 图形派工台，无需记命令 | 极低 |
| 可扩展 | 钩子 / 子代理 | 一切皆插件：Skill / Extension / MCP / 市场 | 封闭 |
| 宿主 vs 底层 | 自己就是 agent | 宿主：派发并监控 Claude Code / OpenCode / Gemini 等外部 agent（ACP） | 自己就是模型前端 |
| 领域增强 | 无 | 3D 空间 / GIS / DuckDB 空间分析（独有） | 无 |
| 安全护栏 | 权限确认 | 三档权限护栏（只读 / 允许编辑 / 完全执行）+ 命令守卫 | 对话级 |

**关键洞察**：GreyWork 不与 Claude Code / Pi 正面竞争「谁的模型更强」，而是竞争「谁让这些 agent 更好用、更可见、更可治理」。它是 agent 的操作系统（宿主），而不是又一个 agent 本身。

## 我们的价值主张（给谁、解决什么）

1. **给开发者 / 工程师**：在熟悉的可视化工作台里指挥 Claude Code 级别的 Agent 干活，不必离开 GUI 切终端；文件 diff、commit、审查一站完成。
2. **给非终端用户 / 数据分析师 / 创意工作者**：用「派工台」自然语言派任务，看得见多 Agent 怎么分工、做到哪一步，而不是盯着黑屏日志。
3. **给团队**：插件市场 + 命令守卫 + 权限档位，让 AI 执行可控、可审计、可复装。
4. **给空间 / 地理场景用户（差异化）**：3D 数字地球、GIS 图层、空间 SQL，把 agent 产出直接落到空间可视化，这是 Claude Code 和 Pi 都不具备的能力。

## 能力地图（落到实际包）

| 定位卖点 | 承载包 | 说明 |
| --- | --- | --- |
| 看得见 Agent 在工作 | `packages/workbench` + `packages/agents` | 协作看板、状态灯、轨道环、步骤卡 |
| 强执行力 + 文件 / Git / 命令 | `packages/editor` + `packages/plugins`（命令守卫） | CodeMirror、Git commit、命令白名单 |
| 派发外部强 agent | `packages/acp` + `apps/desktop/src-tauri/acp_host.rs` | 经 ACP 拉起 Claude Code / OpenCode / Gemini |
| 多 Agent 并行编排 | `packages/agents`（orchestrator / workflow） | 采集→分析→报告流水线 |
| 一切皆插件 | `packages/plugins` + `packages/shell`（市场） | Skill / Extension / MCP 标准 + 远程源 |
| 安全护栏（折中关键） | `packages/plugins`（guard）+ UI 权限三档 | 只读 / 允许编辑 / 完全执行 |
| 差异化空间能力 | `packages/spatial` / `gis` / `analytics` | Cesium、MapLibre、DuckDB-WASM |
| 模型供应商 / 会话 / 搜索 | `packages/llm` / `shell` / `acp` | openai-compatible 流式 |

## 设计语言如何服务定位

视觉方案（机加工工作台 · 仪表面板，见 `ui-design.md`）本身就是折中立场的表达：

- **不是聊天软件**（区别于 Pi）：仪表读数、铭牌、LED 状态灯，强调「这是一台在工作的工作台」。
- **不是裸终端**（区别于 Claude Code）：派工控制台把命令护栏画成机器护栏，完全执行档带警示条纹——把 Claude Code 那种隐性的「危险命令确认」变成显性的、可感知的视觉语言。
- **多色 Agent 系统**：每个 agent 有主题色，让「并行编排」这件 Claude Code 看不到的事，在 GreyWork 里一眼可见。

## 对外叙事（用于 README / 官网 / 市场）

```
GreyWork
看得见 Agent 在工作的桌面 AI 协同工作台。
继承 Claude Code 的文件 / 命令 / Git 执行力，
拥有 Pi 级的可视化与零门槛上手，
再用「一切皆插件」+ 3D/GIS 空间能力把它带向工程与空间场景。
```

## 边界与克制（避免做歪）

- **不做**：自研大模型、与 Claude Code 拼推理质量、纯聊天机器人。
- **重点做**：agent 宿主体验、可视化编排、权限治理、插件生态、空间增强。
- **最危险的偏离**：退化成「又一个带 GUI 的聊天框」（失去 Claude Code 的工程深度），或退化成「只剩终端日志的监控面板」（失去 Pi 的亲和与可见性）。折中的本质是**工程深度 × 可见亲和力**同时在线。
