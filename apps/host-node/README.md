# @greywork/host-node

GreyWork headless 宿主的 **Node 实现**（`apps/server` 的迁移目标）。

P0 只做「换后端不换契约」的地基：HTTP 路由、会话/登录、命令分发、静态托管、事件流。
命令实现按领域逐步搬，完整计划见 [docs/node-backend-migration.md](../../docs/node-backend-migration.md)。

## 现状（P0）

| 项                                                          | 状态                                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /api/health`                                           | 已实现，与 Rust 同字段                                                             |
| `POST /api/login` / `POST /api/logout` / `GET /api/session` | 已实现：cookie + Bearer、argon2 PHC 校验、失败限流 5 次/60s                        |
| `GET /api/commands`                                         | 已实现：185 条元数据（Rust 导出快照），`available` 标出是否已迁移                  |
| `POST /api/command`                                         | 部分：仅 `store_default_root` 已实现；未迁移命令回 501，桌面专属 403，未知命令 400 |
| `GET /api/events` (WS)                                      | 已实现：`host://hello` + 30s ping                                                  |
| 静态 SPA                                                    | 已实现：入口 no-cache、`/assets/*` 一年 immutable、越界路径回落入口                |
| `GET /api/media`                                            | 未实现（P2：依赖 workspace 路径解析与 Range）                                      |
| `hash-password` 子命令                                      | 已实现，与 Rust 同用途（Electron 首启用）                                          |

与 Rust 的三处已知差异（P1 补齐）：CSP 只覆盖同源、Origin 白名单为精确匹配、登录限流是固定窗口而非令牌桶。

## 运行

```bash
# 开发：编译后起服务（默认 127.0.0.1:8787）
GREYWORK_BIND=127.0.0.1:17900 \
GREYWORK_PASSWORD=dev-password \
GREYWORK_STATIC_DIR=../desktop/dist \
pnpm --filter @greywork/host-node dev

pnpm --filter @greywork/host-node test
pnpm --filter @greywork/host-node typecheck
```

环境变量与 `apps/server` 逐字一致（`GREYWORK_BIND` / `GREYWORK_DATA_DIR` / `GREYWORK_PASSWORD_HASH` /
`GREYWORK_STATIC_DIR` / `GREYWORK_TRUSTED_HOST` / `GREYWORK_ALLOWED_ORIGINS` / `GREYWORK_EXIT_ON_STDIN_EOF` /
`GREYWORK_AGENT_PROGRAMS` …），所以 Electron 换后端只需要改「spawn 哪个可执行文件」。

`GREYWORK_AGENT_PROGRAMS` 是 `acp_start` 内置白名单之外的冻结放行面（逗号分隔，如
`GREYWORK_AGENT_PROGRAMS=codebuddy,my-agent`）：headless 服务端只认这份配置，不读 DB（DB 可经
`db_agents_sync` 被客户端改写）。可信本机宿主（`GREYWORK_TRUSTED_HOST=1`）会把设置里已启用的自配后端
目录一并放行，所以桌面端在「设置 → Agent」新增后端即可，无需改环境变量。

## 命令清单从哪来

`src/command-manifest.json` 由 Rust 侧导出，**不要手改**：

```bash
pnpm --filter @greywork/host-node manifest
```

真源是 `crates/greywork-host/src/app/commands/registry.rs` 的 `COMMANDS`，
`crates/greywork-host/examples/dump_commands.rs` 负责序列化；命令表改动后重跑一次即可。
