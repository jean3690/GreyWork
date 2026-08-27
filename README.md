[![CI](https://github.com/jean/greyWork/actions/workflows/ci.yml/badge.svg)](https://github.com/jean/greyWork/actions/workflows/ci.yml)

# GreyWork

> **命名与定位（2026-08-24）**：项目定位锚定「一切皆插件」架构哲学；项目名确定为 **GreyWork**（曾评估更名 Tessera，经裁定放弃），后续方案与实现均以 GreyWork 为准。架构与包职责见 `docs/architecture.md`。

> **定位（2026-08-27）**：GreyWork 是 **Claude Code × Pi 的折中** —— 继承 Claude Code 的文件 / 命令 / Git 执行力，拥有 Pi 级的可视化与零门槛上手，再用「一切皆插件」+ 3D/GIS 空间能力把它带向工程与空间场景。一句话：**一个能「看得见 Agent 在工作」的桌面 AI 协同工作台。** 定位总纲见 `docs/positioning.md`。

> 面向未来的**可拼装** AI 协同工作台 —— 以「一切皆插件」为架构第一原则，深度融合 AI Agent 智能协作、3D 空间计算与 GIS 地理信息系统，为通用人群、开发者、数据分析师和创意工作者提供一站式智能工作环境。

本仓库采用 **pnpm + workspaces** 的 Monorepo 架构，将所有应用与可复用能力沉淀为独立包，并通过 workspace 协议在本地直接引用源码。

## 能力蓝图

- **一切皆插件**：Skill / Extension / MCP 标准接口 + 插件市场 + 会话管理
- **AI 协作**：多 Agent 并行、任务编排（采集 → 分析 → 报告）、命令守卫
- **3D + GIS**：CesiumJS 数字地球、MapLibre 2D/3D 地图、MBTiles / GeoJSON / 3D Tiles 本地数据
- **空间分析**：DuckDB-WASM 空间 SQL、百万级点云实时渲染基础
- **工作区**：CodeMirror 编辑器、文档/表格预览、Git 版本控制
- **开放集成**：MCP、GitHub、Jira、Slack、自定义模型供应商、网页搜索

## 仓库结构

```
greywork/
├── apps/
│   ├── desktop/        # Tauri 桌面端（Vue 3 + Vite + Rust）
├── packages/
│   ├── core/           # @greywork/core         核心类型与数学工具
│   ├── agents/         # @greywork/agents       Agent 模型 / 编排 / 循环
│   ├── acp/            # @greywork/acp          ACP 控制面客户端 / 权限映射
│   ├── spatial/        # @greywork/spatial      3D 空间 / Cesium / 数据格式
│   ├── gis/            # @greywork/gis          GIS 投影 / MapLibre / 本地数据源
│   ├── analytics/      # @greywork/analytics    DuckDB-WASM 空间分析
│   ├── plugins/        # @greywork/plugins      Skill / Extension / MCP / 命令守卫
│   ├── integrations/   # @greywork/integrations GitHub / Jira / Slack
│   ├── editor/         # @greywork/editor       文件系统 / Git / CodeMirror / 预览
│   ├── llm/            # @greywork/llm          模型供应商客户端（openai-compatible 流式）
│   ├── shell/          # @greywork/shell        会话 / 模型供应商 / 插件市场
│   ├── workbench/      # @greywork/workbench    桌面 共享工作台 UI
│   └── ui/             # @greywork/ui           共享 UI 组件与视觉令牌
├── docs/               # 架构与协作文档
├── pnpm-workspace.yaml # workspace 声明 + pnpm 11 配置
└── tsconfig.base.json  # 共享 TypeScript 配置
```

## 快速开始

```bash
# 安装依赖（根目录）
pnpm install

# 启动 Tauri 桌面端（Vite 开发服务器）
pnpm dev:desktop

# 启动桌面端（含原生窗口 + Rust 后端）
pnpm tauri dev

# 全量类型检查
pnpm typecheck

# 全量构建
pnpm build
```

### 环境提示

如果在沙盒 / 容器中遇到全局 pnpm store 不可写（例如 `ERR_SQLITE_ERROR unable to open database file`），请改用项目内可写的 store 目录：

```bash
pnpm --store-dir .pnpm-store install
```

## 命令总览

| 命令               | 说明                                     |
| ------------------ | ---------------------------------------- |
| `pnpm dev:desktop` | 启动 `@greywork/desktop` Vite 开发服务器 |
| `pnpm tauri dev`   | 运行 Tauri 桌面开发（前端 + Rust）       |
| `pnpm build`       | 构建桌面端渲染层（vue-tsc + Vite）       |
| `pnpm typecheck`   | 递归执行所有 workspace 包的 `typecheck`  |
| `pnpm check`       | 类型检查 + 全量构建                      |

## 包管理约定

- 所有内部包统一以 `@greywork/*` 命名。
- 内部包默认采用 **源码直出（source exports）**：`exports` 指向 `./src/index.ts`，由上层 Vite 工具链直接编译，避免重复构建步骤。
- 依赖内部包时使用 `workspace:*` 版本协议。
- 新增包时在 `packages/*` 下创建目录，并在包内提供 `package.json`、`tsconfig.json`、`src/index.ts`。

## 技术栈

- 桌面 UI：Vue 3 + TypeScript + Vite
- UI 组件库：shadcn
- 桌面壳：Tauri 2（Rust）
- 3D 渲染：CesiumJS（已接入，含 WebGL 降级）
- 地图渲染：MapLibre GL（已接入，含 WebGL 降级）
- 空间分析：DuckDB-WASM（真实运行时已接入，含 Mock 降级）
- 编辑器：CodeMirror 6（真实编辑器已接入）
- Monorepo 工具：pnpm workspaces
