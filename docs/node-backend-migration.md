# 后端从 Rust 迁到 Node：方案与进度

> 目标：把 headless 宿主（`apps/server` + `crates/greywork-host`，约 42.5k 行生产代码、189 条命令）
> 换成 Node 实现（`apps/host-node`），**API 契约不变**，桌面端 / 浏览器端 / Docker 部署零改动。
>
> 现状：P0 已完成（HTTP + 会话 + 命令分发骨架 + 静态托管 + 事件流，20 条测试）；
> P1 接近完成——双轨对照脚本已落地，路径授权面、读写面（含二进制 / 媒体 / 文件探测）、删除/改名/复制、会话存储、SQLite 全家（设置 / 自动化 / 编排 / 后端目录）、git 只读四条、真 PTY 终端、LLM（聚合四条 + 流式两条）、RAG 状态/清空、worktree 回收、技能安装/卸载、check_update、web_fetch（SSRF）与 **ACP 会话托管** 已迁移（47 条无状态命令通过对照；
> SQLite 迁移链与 Rust 逐条一致，Node 建的库可被 Rust 直接打开并读回设置）。
> Electron 默认仍 spawn Rust 二进制。

---

## 1. 可迁移性结论

| 能力                                                     | 结论       | 依据                                                                                                                                                                                                        |
| -------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP / WS / 静态托管 / 登录                              | 直接迁     | 只有 8 条路由，`apps/server/src/routes/` 共 1.5k 行                                                                                                                                                         |
| 子进程、git、rg/fd/jq、worktree                          | 直接迁     | 都是 `spawn` + 参数校验，Node 等价能力成熟                                                                                                                                                                  |
| PTY 终端                                                 | 直接迁     | `node-pty`（ConPTY / openpty 都覆盖）                                                                                                                                                                       |
| SQLite（设置 / 自动化 / 会话）                           | 直接迁     | `better-sqlite3`；注意同步 API 与 Rust 的事务语义对齐                                                                                                                                                       |
| 通道协议（企微 / 飞书 / 钉钉 / QQ / Telegram / Discord） | 直接迁     | WebSocket + AES + 表单，Node 标准库足够                                                                                                                                                                     |
| **微信 iLink 协议**                                      | 直接迁     | 官方 `@wechatbot/wechatbot@2.2.0`（MIT、零运行时依赖、Node ≥22、77 个测试）：扫码登录、长轮询、文本/图片/视频/文件/语音、CDN 上传下载与加解密、SILK→WAV；与现在用的 Rust `wechatbot` SDK 同一协议、同一作者 |
| 插件市场签名 / SHA-256 / 解包                            | 直接迁     | `node:crypto` 的 ed25519 verify 与 sha256；解包用 `tar`/`yauzl`                                                                                                                                             |
| 老格式 `.xls`（`fs_read_sheet`）                         | **有缺口** | JS 侧无可靠解析器（SheetJS 已下架且带未修 CVE，exceljs 只认 xlsx）                                                                                                                                          |
| 单二进制分发                                             | 变差       | Node 宿主需要带运行时；桌面端可复用 Electron 自带 Node，headless / Docker 需要额外镜像层                                                                                                                    |

**结论：可以迁。** 唯一需要在方案上做取舍的是 `.xls`：见第 6 节的三个选项。

---

## 2. 不变量（换语言不能换的东西）

1. **HTTP 契约**：8 条路由的路径/方法/状态码/错误信封 `{"error": "…"}` 逐字一致；
   成功响应 body 就是命令返回值本身（不是 `{data: …}` 包一层）。
2. **命令契约**：189 个命令名、入参 camelCase、返回值形态不变；`/api/commands` 的
   `{name, auth, desktopOnly, binary, available}` 字段不变。
3. **环境变量**：`GREYWORK_*` 全部同名同义（Electron 的 `sidecar-spec.ts` 只设这些）。
4. **端口与 origin**：默认端口、端口记忆文件、`GREYWORK_EXIT_ON_STDIN_EOF`（父死子死）不变 ——
   否则 localStorage 按 origin 隔离的历史数据会「消失」。
5. **事件信封**：`{event, payload}`，首帧 `host://hello`，30s 心跳。
6. **安全默认值**：未配密码即登录必定失败（fail-closed）、桌面专属命令在 headless 一律 403。

---

## 3. 迁移策略：领域切片 + 快照 + 可用性标记 + 双轨对照

半成品后端会让应用直接不可用，所以不能「换掉入口再补实现」。做法是四条并行：

1. **命令元数据只从 Rust 导出**（`crates/greywork-host/examples/dump_commands.rs` →
   `apps/host-node/src/command-manifest.json`），Node 不手抄命令名，避免两边漂移。
2. **`available` 由「是否已迁移」决定**：未迁移的普通命令在 `/api/commands` 里是 `false`，
   前端按已知机制灰显，不会「点了才报错」。这复用了仓库既有的 FrontSpec / 能力降级思路。
3. **双轨对照**：同一份请求同时打 Rust 与 Node 宿主，比对状态码 + body（见第 7 节）。
4. **切换开关在 Electron 侧**：`GREYWORK_HOST_KIND=rust|node` 决定 spawn 哪个二进制；
   出问题一个环境变量回滚。

---

## 4. 阶段与验收

| 阶段                   | 范围                                                                                                                                                                                                                  | 验收                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **P0（已完成）**       | `apps/host-node` 骨架：config / 会话与 argon2 / 8 条路由 / 命令分发 / 静态托管 / WS / `hash-password`；命令清单导出                                                                                                   | 20 条测试（会话、限流、cookie、401/403/400/501、静态缓存头、安全头、WS 鉴权与 hello）；`pnpm typecheck` 绿             |
| **P1（已完成 32 条）** | 工作台核心：`db_settings_*` / `fs_*`（15）/ `git_*`（4）/ `store_*`（3）/ `worktree_list/release`（2）/ `terminal_*`（5，node-pty）；中间件补齐（CSP / Origin / 限流仍有简化项）                                      | 双轨对照全绿；Node 建的 SQLite 库 Rust 可直接打开；桌面端以 `GREYWORK_HOST_KIND=node` 跑通「新建会话 → 改文件 → 终端」 |
| **P2（已完成 14 条）** | ACP 会话托管（start / new_session / load_session / send / 权限应答 / set_mode / set_config / set_permission_tier / cancel / stop）与 LLM（list_models / embed / chat_complete / transcribe / chat_start / chat_stop） | mock agent 端到端（含权限请求应答）；本地 mock 端点的双轨对照；`llm_agent_start/stop` 与 `/api/media` 仍未迁移         |
| **P3（部分，2 条）**   | 通道七件套（微信走 `@wechatbot/wechatbot`，其余手写协议），含凭据落盘 0600、事件与命令、媒体收发                                                                                                                      | 每条通道一组「状态 / 登录 / 收发 / 断开」对照测试；微信真机扫码冒烟                                                    |
| **P4（部分）**         | 插件市场、RAG（status/clear 已迁，build/search 未迁）、office 转换、control-plane 同步；随后删除 Rust 宿主                                                                                                            | 全量双轨对照；打包三平台安装包（桌面 / Docker）；删除 `apps/server` 与 `crates/greywork-host`                          |

**每个阶段的 Definition of Done**：双轨对照全绿 + 原有 Rust 测试里对应用例在 Node 侧有等价覆盖 +
文档（本文的进度表、`docs/*.md` 里的实现链接）同步。

---

## 5. 组件映射

| Rust                     | Node                   | 备注                                         |
| ------------------------ | ---------------------- | -------------------------------------------- |
| axum + tower-http        | `node:http` + `ws`     | P0 已用；不引框架，路由只有 8 条，手写更可控 |
| argon2                   | `hash-wasm`            | 纯 JS（WASM），免原生编译；PHC 串互通        |
| rusqlite (bundled)       | `better-sqlite3`       | 同步 API，事务语义接近                       |
| portable-pty             | `node-pty`             | Windows 走 ConPTY                            |
| wechatbot（Rust SDK）    | `@wechatbot/wechatbot` | 官方同协议 Node SDK                          |
| calamine（xls/xlsx/ods） | 见第 6 节              | 唯一功能缺口                                 |
| ed25519-dalek + sha2     | `node:crypto`          | verify / createHash                          |
| reqwest + rustls         | `fetch`（undici）      | 代理与超时策略需显式配置                     |
| tokio-tungstenite        | `ws`                   | 通道长连接                                   |
| 进程沙箱（bwrap）        | —                      | 2026-10-13 已停用，不再需要                  |

---

## 6. `.xls` 的三个选项

1. **保留一个极小的 Rust 旁路进程**（只做 `fs_read_sheet`）：与新后端并存，几十行，打包体积增加约 2 MB。
2. **改由前端解析**：xlsx 已由 exceljs 覆盖；`.xls` 在业务里占比很低，明确降级为「不支持，请另存为 xlsx」。
3. **引入 LibreOffice / soffice 转换**：自动化转换链路本来就有 `GREYWORK_SOFFICE_PATH`，复用它把 xls 转 xlsx 再解析。

建议按 1 → 3 的顺序评估：先保证功能不丢，再减少一个二进制。

---

## 7. 双轨对照怎么跑

已交付 `scripts/host-parity.mjs`（`pnpm host:parity`）：

1. 以同一份 `GREYWORK_*` 环境变量分别启动 Rust 与 Node 宿主（不同端口、不同数据目录）；
2. 登录拿 token，按「命令 + 参数」清单逐条打 `POST /api/command`；
3. 归一化（时间戳、绝对路径、随机 id）后比对状态码与 JSON 结构；
4. 输出差异清单，CI 里作为门禁。

命令清单同样来自 `command-manifest.json`，只比对两边都标记为 available 的命令。

---

## 8. 风险与回滚

| 风险                              | 处置                                                      |
| --------------------------------- | --------------------------------------------------------- |
| 迁移期两套实现行为漂移            | 双轨对照进 CI；`available` 标记只在不一致清零后打开       |
| PTY / 子进程在 Windows 上行为差异 | 三平台 CI（仓库已有 Windows / macOS job）跑 P1 用例       |
| Node 宿主内存占用高于 Rust        | P1 结束做一次基线测量（空载 + 10 会话），超过阈值再评估   |
| 分发体积 / 依赖运行时             | 桌面端复用 Electron 内置 Node；Docker 镜像 `node:22-slim` |
| 回滚                              | `GREYWORK_HOST_KIND` 切回 rust；Rust 代码在 P4 之前不删除 |

---

## 9. 明确不做

- 不换前端契约、不改命令名、不重命名环境变量；
- 不在迁移期引入第二套数据库 schema（Node 直接读写同一份 SQLite 文件，P1 先只读后写）；
- 不把插件运行时（Worker / 渲染指令）搬到 Node —— 那部分本来就在渲染进程里。
