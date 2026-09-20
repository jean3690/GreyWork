# GreyWork

[English](README.md) | **简体中文**

[![CI](https://github.com/jean3690/GreyWork/actions/workflows/ci.yml/badge.svg)](https://github.com/jean3690/GreyWork/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB)
![Vue 3](https://img.shields.io/badge/Vue-3-42B883)

面向开发者的桌面优先 AI Agent 工作台 —— 用代码、图表与多智能体协作来思考。

GreyWork 把外部编码智能体（走 **Agent Client Protocol**）与本机 OpenAI 兼容模型收进同一个工作台：
带工具时间线与权限门禁的对话、受授权的工作区与文件预览 / Git、插件 · MCP · 技能市场、定时任务，
以及七条消息通道 —— 在手机上也能使唤本机助手。

## 功能

**Agent 运行时**

- ACP（Agent Client Protocol）后端：接入外部智能体、管理会话、向 agent 声明 MCP 服务器；
  会话配置项（模型 / 思考强度 / 会话模式）由后端探测得出，也能逐项覆盖。
- 本机模型管线：OpenAI 兼容的流式供应商，支持自定义请求头（可用 `{{ENV}}` 占位）与思考强度控制。
- 权限模型：三档（只读 / 工作区 / 完全访问），宿主拦截越界路径与只读档下的写 / 执行操作；
  「始终允许」按工具类别在单次会话内记忆；每次裁决都在消息流里留一条只读**权限留痕**，
  说明批了什么、谁批的、为什么没问。

**工作区**

- 授权工作区根目录：文件、Git、进程操作全部限定在解析出的根目录内。
- 文件预览覆盖文本（CodeMirror 6，多语言高亮）、Markdown、CSV、图片、PDF 与 Office 文档；
  预览面板支持标签拖拽排序、中键关闭与异步骨架屏。
- Git 经宿主 CLI 提供，严格限制在工作区内。

**可扩展性**

- 插件运行时基于 Cordis 微内核，能力**按插件**显式授权；声明式插件包只含受限 JSON，不执行远端 JavaScript。
- 插件作者指南见 [docs/plugin-authoring.md](docs/plugin-authoring.md)，市场发布流程见
  [plugin-market/README.md](plugin-market/README.md)。
- **市场**收在一处：官方插件注册表（带签名 —— GitHub 账号失陷也无法投毒目录）、MCP Registry
  与 skills.sh 等技能源。
- Agent 技能放在 `.agents/skills/`，由 `skills-lock.json` 记录哈希锁定。

**对话之外**

- 定时任务：cron 或一次性触发；AI 还能在回复里用 `schedule` 围栏提议任务，确认后才真正创建。
- 远程助手：微信（ClawBot / iLink）、钉钉、飞书、Telegram、QQ、Discord、企业微信；
  凭证只存在本机应用数据目录（0600），不进设置快照。
- 团队协作会话：多个成员跑同一任务，各自可配 ACP 会话配置。
- 活动面板汇总会话中产生的产物。

**平台**

- Tauri 2 桌面外壳（Linux / macOS / Windows）+ Rust 宿主 + Vue 3 渲染层。
- 中英双语界面（zh-CN / en-US）；界面跑在浏览器里时，宿主能力自动降级为只读提示。

## 技术栈

| 层次   | 选型                                                                            |
| ------ | ------------------------------------------------------------------------------- |
| 桌面端 | Tauri 2、Rust、rusqlite、tokio、reqwest、`agent-client-protocol`                |
| 界面   | Vue 3、Vite、Pinia、vue-router、vue-i18n、Tailwind、shadcn-vue（reka-ui）       |
| 编辑   | CodeMirror 6、Univer（表格 / 文档）                                             |
| 插件   | Cordis 微内核                                                                   |
| 工程   | pnpm workspace、TypeScript、Vitest（node + dom 两个 project）、ESLint、Prettier |

## 目录结构

```
greyWork/
├── apps/
│   └── desktop/              # Tauri 外壳：Vite + Vue 渲染层 + Rust 宿主
├── packages/
│   ├── core/                 # 共享类型与数学工具（零依赖）
│   ├── editor/               # 文件系统、Git、CodeMirror 抽象
│   ├── agents/               # Agent 领域逻辑（角色、事件、编排）
│   ├── llm/                  # LLM 供应商客户端（OpenAI 兼容流 → IPC）
│   ├── acp/                  # Agent Client Protocol 客户端（Tauri IPC + WebSocket）
│   ├── shell/                # 供应商注册表与传输数据面
│   ├── plugins/              # 插件市场适配器与类型
│   ├── cowork/               # 协作工作区引擎
│   └── workbench/            # 统一 UI 包（外壳、视图、插件运行时）
├── plugin-market/            # 插件注册表源与签名
├── .agents/skills/           # 已安装的 agent 技能（vendored）
└── skills-lock.json          # 带哈希锁定的技能定义
```

依赖方向由 ESLint 强制：叶子包只依赖 `@greywork/core`（或零依赖），`workbench` 负责组合，
且 `packages/` 一律不得反向依赖 `apps/`。

完整依赖图与宿主模块划分见 [docs/architecture.md](docs/architecture.md)。

## 快速开始

```bash
# 前置
#   Node >= 20，pnpm >= 9（建议 corepack）
#   Rust stable + 平台 Tauri 依赖（仅桌面外壳需要）

git clone https://github.com/jean3690/GreyWork.git
cd GreyWork
pnpm install
pnpm dev        # 起 Vite 开发服务器 + Tauri 窗口
```

Wayland 环境下用 `pnpm tauri:wayland`，它会带上必要的环境变量。

## 常用命令

| 命令               | 说明                                   |
| ------------------ | -------------------------------------- |
| `pnpm dev`         | 启动桌面端开发环境（Vite + Tauri）     |
| `pnpm lint`        | 全仓 ESLint                            |
| `pnpm format`      | Prettier 写入（`format:check` 仅校验） |
| `pnpm typecheck`   | 全 workspace TypeScript 检查           |
| `pnpm test`        | 各 package 跑 Vitest                   |
| `pnpm build`       | 构建桌面端渲染层                       |
| `pnpm tauri build` | 构建完整 Tauri 安装包                  |
| `pnpm check`       | `typecheck` + `build`                  |

Rust 侧（在 `apps/desktop/src-tauri` 下执行）：`cargo fmt`、`cargo clippy --all-targets -- -D warnings`、
`cargo test` —— 带 `--all-targets` 才会连 `tests/`、`examples/` 一起 lint。

各平台出什么包、Windows 安装包怎么处理 WebView2、代码签名还差什么，见
[docs/packaging.md](docs/packaging.md)。

## 测试与 CI

- Vitest 分 `node`（纯逻辑）与 `dom`（组件行为）两个 project，覆盖率阈值按包配置。
- `.github/workflows/ci.yml` 与本地钩子同构，但 web 侧的检查拆成 4 个并行 job（lint / typecheck /
  测试 / 渲染层构建），墙钟取最慢的一个而不是各步之和；另有 Rust job（`cargo fmt` →
  `cargo clippy --locked` → `cargo test --locked`）、Windows job（`cargo test --locked` + vitest，
  唯一会编译并运行 `#[cfg(windows)]` 代码的地方）、macOS job（`cargo clippy --locked` →
  `cargo test --locked` + vitest，唯一会编译并运行 `#[cfg(target_os = "macos")]` 代码的地方）
  和三平台打包矩阵（deb / NSIS / dmg）。
- 打 `v*` 标签触发 `.github/workflows/release.yml`，产出 deb / NSIS / dmg 并开一个 draft Release；
  macOS 走通用二进制，Intel Mac 也能装。Release 正文自动取自 [CHANGELOG.md](CHANGELOG.md) 里该版本的
  条目，三个平台都成功后取消 draft 即发布。打包与 CI 共用 `tauri` 这份 Rust 缓存键，因此 tag 构建直接
  复用 master 上已编译好的依赖产物。
- pre-push 钩子会跑 `pnpm lint && pnpm -r test`，问题在本地就拦住。

## 安全模型

GreyWork 把渲染层当作对原生宿主不可信：

- 声明式插件包只含受限 JSON，无法执行远端 JavaScript。
- 插件能力授权是显式的，并在宿主边界校验。
- 工作区根目录授权限定文件、Git 与进程执行范围。
- 自由进程执行走沙箱与守卫。
- 通道与模型供应商凭证以 `0600` 存放在应用数据目录，且不进设置快照。
- Tauri 窗口配置了严格 CSP。

## 贡献

提交规范、钩子与评审流程见 [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md)。UI 改动需附实测说明；
架构与设计决策分别写在 [docs/architecture.md](docs/architecture.md) 与
[docs/ui-design.md](docs/ui-design.md)。

## 许可

[MIT](LICENSE)
