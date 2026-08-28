# GreyWork 架构概览

## 分层

```
┌─────────────────────────────────────────────────────────────┐
│ apps/desktop (Tauri 桌面壳)                                  │
├─────────────────────────────────────────────────────────────┤
│ packages/shell       会话 / 模型供应商 / 插件市场 / AI 循环策略 │
│ packages/llm         模型供应商客户端（openai-compatible 流式）│
│ packages/editor      文件系统 / Git / CodeMirror / 文档表格预览     │
│ packages/workbench   桌面共享工作台 UI（GreyWork Core 等）      │
├─────────────────────────────────────────────────────────────┤
│ packages/plugins     Skill / Extension / MCP 标准与命令守卫     │
│ packages/integrations GitHub / Jira / Slack 连接器             │
├─────────────────────────────────────────────────────────────┤
│ packages/agents      Agent 领域模型 / 编排流水线 / Agent 循环   │
│ packages/acp         ACP 控制面客户端 / 权限映射              │
│ packages/spatial     3D 空间计算 / Cesium 适配 / 空间数据格式    │
│ packages/gis         GIS 投影 / MapLibre 适配 / 本地数据源      │
│ packages/analytics   DuckDB-WASM 空间分析客户端                 │
├─────────────────────────────────────────────────────────────┤
│ packages/core        类型与基础数学                            │
└─────────────────────────────────────────────────────────────┘
```

## 功能 → 包 映射

| 产品能力                                                 | 承载包                   |
| -------------------------------------------------------- | ------------------------ |
| Skill / Extension / MCP 标准接口                         | `@greywork/plugins`      |
| 命令守卫（限制 AI 每一条命令）                           | `@greywork/plugins`      |
| GitHub / Jira / Slack 接入                               | `@greywork/integrations` |
| 文件系统 / CodeMirror / 文档与表格预览 / Git             | `@greywork/editor`       |
| CesiumJS 3D 数字地球 / 3D Tiles                          | `@greywork/spatial`      |
| MapLibre 2D/3D 地图 / MBTiles / GeoJSON                  | `@greywork/gis`          |
| 多 Agent 并行编排（采集→分析→报告）                      | `@greywork/agents`       |
| ACP 控制面客户端 / 权限映射（与 Rust acp_host 对称）     | `@greywork/acp`          |
| DuckDB-WASM 空间分析                                     | `@greywork/analytics`    |
| 会话管理 / 模型供应商 / 网页搜索 / 插件市场              | `@greywork/shell`        |
| 模型供应商客户端（openai-compatible 流式）               | `@greywork/llm`          |
| 桌面共享工作台 UI（GreyWork Core / GIS / 编辑器 / 市场） | `@greywork/workbench`    |

## 依赖方向

- `apps/*` 可依赖任意 `packages/*`。
- 领域包（agents / spatial / gis / analytics）只依赖 `@greywork/core`，保持领域逻辑与 UI 解耦。例外：`@greywork/spatial` 依赖 `@greywork/gis`（同为空间领域，示例城市点同源派生，避免双份数据）。
- `packages/shell` 依赖 `@greywork/agents` 与 `@greywork/plugins`，是平台的“宿主”。
- 禁止 `packages/*` 相互反向依赖 `apps/*`。

## 新增领域包

1. 在 `packages/<name>` 下创建 `package.json`、`tsconfig.json`、`src/index.ts`。
2. 包名使用 `@greywork/<name>`，`private: true`。
3. 对外 API 从 `src/index.ts` 统一导出。
4. `pnpm-workspace.yaml` 无需改动（`packages/*` 自动识别）。

## 设计与演进约束

- 桌面端复用工作台 UI 层，避免业务逻辑在 app 内重复。
- 领域包保持纯 TypeScript/null 依赖，便于未来迁移到独立服务或 Rust 模块。
- 核心原则：**一切皆插件** —— Skill/Extension/MCP 统一注册、可插拔、可审计。
