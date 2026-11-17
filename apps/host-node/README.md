# @greywork/host-node

GreyWork headless 宿主，也是 Electron 的 Node sidecar。原 Rust 宿主已迁移并删除，当前所有宿主
命令由本包承接；迁移历史见 [docs/node-backend-migration.md](../../docs/node-backend-migration.md)。

## 接口与能力

| 项                                                          | 状态                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /api/health`                                           | 已实现，与 Rust 同字段                                                      |
| `POST /api/login` / `POST /api/logout` / `GET /api/session` | 已实现：cookie + Bearer、argon2 PHC 校验、失败限流 5 次/60s                 |
| `GET /api/commands`                                         | 返回静态清单；`available` 表示该命令在当前宿主权限下可调用                  |
| `POST /api/command`                                         | 分发至领域实现；桌面壳专属 / 未授权命令回 403，未知命令 404                 |
| `GET /api/events` (WS)                                      | 已实现：`host://hello` + 30s ping                                           |
| 静态 SPA                                                    | GET / HEAD；入口 no-cache、根内 assets 一年 immutable；真实路径越界回落入口 |
| `GET /api/media`                                            | 已实现：会话认证、工作区路径授权、Range 分片                                |
| `hash-password` 子命令                                      | 已实现，与 Rust 同用途（Electron 首启用）                                   |

主要领域包括工作区 / Git / 会话存储、ACP、LLM / 本机 agent、MCP / 技能、消息通道、Office、RAG
与控制面接入。完整边界与配置见 [docs/architecture.md](../../docs/architecture.md)。

网络部署注意：CSP 只覆盖同源，Origin 白名单为精确匹配，登录限流采用固定窗口（5 次失败 / 60s）。
不要把 `GREYWORK_TRUSTED_HOST=1` 用于公开网络宿主。

## 运行

```bash
# 以下命令在仓库根执行；仅提供 API 时可省略静态目录配置与渲染层构建。
pnpm build:desktop

# 开发：编译后起服务（默认 127.0.0.1:8787）
GREYWORK_BIND=127.0.0.1:17900 \
GREYWORK_PASSWORD=dev-password \
GREYWORK_STATIC_DIR=../desktop/dist \
pnpm --filter @greywork/host-node dev

pnpm --filter @greywork/host-node test
pnpm --filter @greywork/host-node typecheck
```

主要环境变量包括 `GREYWORK_BIND` / `GREYWORK_DATA_DIR` / `GREYWORK_PASSWORD_HASH` /
`GREYWORK_STATIC_DIR` / `GREYWORK_TRUSTED_HOST` / `GREYWORK_ALLOWED_ORIGINS` / `GREYWORK_EXIT_ON_STDIN_EOF` /
`GREYWORK_AGENT_PROGRAMS` 等。未配置密码 / 密码哈希时，登录会明确失败，不会匿名放行 API。

静态目录必须含根内的普通 `index.html` 文件，启动时会解析符号链接并校验边界。请求路径只做一次
URL 解码，支持中文与空格文件名；非法编码 / 空字节回 400。静态目录是公开资源面，不要放入凭据
或私有工作区文件。

`GREYWORK_AGENT_PROGRAMS` 是 `acp_start` 内置白名单之外的冻结放行面（逗号分隔，如
`GREYWORK_AGENT_PROGRAMS=codebuddy,my-agent`）：headless 服务端只认这份配置，不读 DB（DB 可经
`db_agents_sync` 被客户端改写）。可信本机宿主（`GREYWORK_TRUSTED_HOST=1`）会把设置里已启用的自配后端
目录一并放行，所以桌面端在「设置 → Agent」新增后端即可，无需改环境变量。

## 命令清单从哪来

Rust 宿主删除后，`src/command-manifest.json` 是**静态手工维护**的清单（旧文档里的
`pnpm --filter @greywork/host-node manifest` 生成器已不存在）。新增命令要同时：

1. 在 manifest 加一条 `{ name, auth, desktopOnly, binary }`（`desktopOnly: true` 会被
   `dispatch` 无条件 403，仅用于「由 Electron 壳实现、不在 Node 宿主」的命令）；
2. 在 `src/commands.ts` 的 `HANDLERS` 注册实现。

只做其中一件会分别得到 404（缺 manifest）或 `available: false`（缺实现）。需要限制为
可信本机宿主才能调用的命令，再加进 `TRUSTED_HOST_ONLY`。
