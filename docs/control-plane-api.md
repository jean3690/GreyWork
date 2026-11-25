# 控制面接口一览（back/grey）

> 面向联调：按模块列出路径、认证要求与关键参数。请求/响应 DTO 以
> `back/grey/src/main/java/com/jean/grey/**/web/*Controller.java` 里的 `record` 为准；
> 运维面（`/api/admin/**`）单独见 [control-plane-auth.md](control-plane-auth.md)。

## 通用约定

- Base URL 默认 `http://localhost:8080`。
- 认证：`Authorization: Bearer <token>`（密码 / OIDC 等登录方式最终都发同一种 token）。
- 未登录 → `401`；已登录但角色不够 `/api/admin/**` → `403`。
- 错误体：`{ "code": "snake_case", "message": "中文说明" }`；参数校验失败额外带 `fields`。
- 时间字段：服务端时区的 ISO-8601（`LocalDateTime`），不做 UTC 标记。
- 匿名可访问：`POST /api/auth/login`、`POST /api/auth/register`、`/api/auth/oidc/**`、`POST /api/channels/webhook/*`、
  `/actuator/health`、`POST /api/admin/auth/login`、`/admin/**`（页面本身）。

## 认证与设备

| 方法   | 路径                                      | 认证 | 说明                                                           |
| ------ | ----------------------------------------- | ---- | -------------------------------------------------------------- |
| POST   | `/api/auth/login`                         | 匿名 | `{ email, password, deviceName, platform }` → token            |
| POST   | `/api/auth/register`                      | 匿名 | `{ email, password, displayName?, deviceName, platform }` → token（注册即登录；邮箱重复 409） |
| GET    | `/api/auth/me`                            | 是   | 当前用户 + 当前设备（含 `role`）                               |
| PATCH  | `/api/auth/me`                            | 是   | `{ displayName }` 更新本人昵称（1–128 字符）；回当前用户与设备 |
| POST   | `/api/auth/logout`                        | 是   | 撤销当前 token（204）                                          |
| DELETE | `/api/auth/sessions?includeCurrent=false` | 是   | 撤销其他设备（或全撤）的会话，回 `{ devices, currentRevoked }` |
| GET    | `/api/devices`                            | 是   | 当前用户的设备清单，含 `current` 标记                          |
| DELETE | `/api/devices/{id}`                       | 是   | 吊销指定设备（删行 + 撤会话）                                  |
| GET    | `/api/auth/oidc/providers`                | 匿名 | provider → 是否启用                                            |
| GET    | `/api/auth/oidc/{provider}/authorize`     | 匿名 | 302 到身份源；需 `redirect`（白名单内）                        |
| GET    | `/api/auth/oidc/{provider}/callback`      | 匿名 | 302 回客户端并附 `ticket`                                      |
| POST   | `/api/auth/oidc/exchange`                 | 匿名 | `{ ticket }` → 与密码登录相同的 session                        |

用户和设备 ID 在密码登录、注册、当前身份及设备列表响应中均按字符串返回，避免浏览器截断 Long ID。
昵称更新仅修改该字段，不写入客户端提交的邮箱或角色；设备吊销验证归属，跨用户请求返回 404。

## 增量同步

| 方法   | 路径                                  | 说明                                                      |
| ------ | ------------------------------------- | --------------------------------------------------------- |
| GET    | `/api/sync/changes?since=&limit=`     | 按 revision 拉增量；回 `{ revision, hasMore, changes[] }` |
| PUT    | `/api/sync/objects/{kind}/{objectId}` | `{ baseRevision, payload }`；冲突时按 revision 拒绝       |
| DELETE | `/api/sync/objects/{kind}/{objectId}` | 软删一个对象，可带 `baseRevision`                         |

## 宿主

| 方法 | 路径                                       | 说明                                                     |
| ---- | ------------------------------------------ | -------------------------------------------------------- |
| PUT  | `/api/hosts/me`                            | 注册/更新当前设备为宿主（name / version / capabilities） |
| POST | `/api/hosts/me/heartbeat`                  | 心跳（90 秒有效）                                        |
| GET  | `/api/hosts`                               | 当前用户的宿主列表（在线状态来自心跳）                   |
| GET  | `/api/hosts/me/bindings`                   | 本宿主要连的通道绑定                                     |
| GET  | `/api/hosts/me/messages?since=`            | 游标拉取入站消息                                         |
| POST | `/api/hosts/me/automation/claim`           | `{ limit }` 认领到期任务（带租约，条件更新防抢）         |
| POST | `/api/hosts/me/automation/due/{id}/finish` | `{ status, detail, sessionId, output }` 回执             |

## 通道

| 方法   | 路径                                   | 说明                                                            |
| ------ | -------------------------------------- | --------------------------------------------------------------- |
| POST   | `/api/channels/bindings`               | `{ platform, accountRef, hostDeviceId? }` → 绑定 + webhookUrl   |
| GET    | `/api/channels/bindings`               | 当前用户的绑定，`status` 是有效状态（active/degraded/disabled） |
| POST   | `/api/channels/bindings/{id}/reassign` | `{ hostDeviceId }` 改归属宿主                                   |
| POST   | `/api/channels/bindings/{id}/disable`  | 停用（用户侧）                                                  |
| POST   | `/api/channels/bindings/{id}/enable`   | 启用                                                            |
| DELETE | `/api/channels/bindings/{id}`          | 解绑                                                            |
| POST   | `/api/channels/webhook/{bindingId}?k=` | **匿名**，平台回调；secret 不匹配 401，停用 409                 |

平台枚举：`wechat / wecom / feishu / dingtalk / qq / telegram / discord`。

## 模型网关

| 方法   | 路径                    | 说明                                                             |
| ------ | ----------------------- | ---------------------------------------------------------------- |
| POST   | `/api/llm/keys`         | `{ provider, label?, baseUrl?, apiKey }`；密文入库，回显不含 key |
| GET    | `/api/llm/keys`         | 当前用户的密钥元数据                                             |
| DELETE | `/api/llm/keys/{id}`    | 删除                                                             |
| GET    | `/api/llm/usage?days=1` | 当前用户近 N 天（1-90）的请求 / token 汇总                       |
| POST   | `/v1/chat/completions`  | OpenAI 兼容代理；按用户轮询密钥，受 RPM / 日 token 限额          |

供应商枚举：`openai / anthropic / deepseek / moonshot / qwen / zhipu / ollama / custom`。
未配置 `GREY_MASTER_KEY` 时存取 key 的接口回 `503 master_key_missing`。

## 自动化

| 方法   | 路径                                                | 说明                                      |
| ------ | --------------------------------------------------- | ----------------------------------------- |
| GET    | `/api/automation/tasks`                             | 当前用户的任务列表                        |
| POST   | `/api/automation/tasks`                             | 建任务（cron / 一次性，含执行目标与模型） |
| PUT    | `/api/automation/tasks/{taskId}`                    | 更新                                      |
| POST   | `/api/automation/tasks/{taskId}/enable` / `disable` | 启停                                      |
| DELETE | `/api/automation/tasks/{taskId}`                    | 删除                                      |
| GET    | `/api/automation/tasks/runs?taskId=&limit=`         | 运行记录                                  |
| POST   | `/api/automation/tasks/preview`                     | 只算未来触发点，不落库                    |

调度进程按 `grey.automation.tick-ms` 扫描，到点写入 `automation_due`，由宿主认领执行。

## 对象存储

客户端入口、RustFS 部署和云端任务离线策略见 [cloud-client.md](cloud-client.md)。

| 方法   | 路径                                 | 说明                                 |
| ------ | ------------------------------------ | ------------------------------------ |
| GET    | `/api/storage/config`                | 是否启用、单对象上限等（登录后可读） |
| POST   | `/api/storage/uploads`               | 建上传单，回预签名 URL / 对象 id     |
| POST   | `/api/storage/objects/{id}/complete` | 客户端上传完成后确认                 |
| GET    | `/api/storage/objects?limit=`        | 当前用户的对象列表                   |
| GET    | `/api/storage/objects/{id}`          | 对象元数据                           |
| GET    | `/api/storage/objects/{id}/download` | 预签名下载 / 直链                    |
| DELETE | `/api/storage/objects/{id}`          | 删除                                 |

未启用 `GREY_S3_ENABLED` 时，除 `config` 外的接口回 `409 storage_disabled`。

## 运维面

`/api/admin/**` 全部要求 `ROLE_ADMIN`，唯一的匿名入口是 `POST /api/admin/auth/login`。
除用户 / 设备 / 通道 / 模型外，还有两块跨用户只读聚合：`GET /api/admin/storage`
（容量与对象明细）与 `GET /api/admin/automation`（任务、积压与执行失败率），对应用户侧接口
分别是「对象存储」与「自动化」两节。端点表、首次部署、故障排查见
[control-plane-auth.md](control-plane-auth.md)。

## 桌面端接入（宿主侧客户端）

桌面端与 headless 宿主共用 `apps/host-node/src/control-plane.ts`，控制面只负责「注册 / 心跳 /
排队 / 记录」，出站调用仍归宿主：

| 命令                            | 用途                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `control_plane_status`          | 当前是否配置、是否已注册、上次心跳/认领、最近结果与错误（不含 token）                    |
| `control_plane_connect`         | `{ baseUrl, token }` 或 `{ baseUrl, email, password, register? }`（邮箱密码登录/注册）；保存后立刻注册一次 |
| `control_plane_run_once`        | 手动跑一轮：注册 → 认领 → 执行 → 回执                                                    |
| `control_plane_disconnect`      | 删除本地接入配置并停掉定时链                                                             |
| `control_plane_account`         | 核验当前账号，仅返回公开身份与连接状态                                                   |
| `control_plane_logout`          | 先撤销服务器 token，再清除本机连接；网络失败保留凭据                                     |
| `control_plane_profile_update`  | `{ displayName }` 更新当前账号昵称                                                       |
| `control_plane_devices`         | 当前账号设备列表与身份，设备 ID 保持字符串                                               |
| `control_plane_device_revoke`   | `{ deviceId }` 吊销其他设备，宿主拒绝当前设备                                            |
| `control_plane_sessions_revoke` | 退出其他设备，固定 `includeCurrent=false`                                                |

- 配置优先级：`GREYWORK_CONTROL_URL` + `GREYWORK_CONTROL_TOKEN`（同时给出才生效）>
  `<dataDir>/control-plane.json`（0600，由设置里的「控制面」分区写入）。
- 节奏：心跳与认领各一条 30s 定时链；单条任务执行上限 25min，租约 30min。
- 执行语义：**本机默认模型供应商的单轮直连**（OpenAI 兼容端点），不调 ACP、不给工具；
  绑定 `acpProviderId` 的任务直接回执 `failed`，留待应用内执行。没配模型供应商时同样回执失败，
  不会卡住认领链。
- 渲染端入口：设置 → 控制面（`ControlPlaneSettingsPane.vue`），支持邮箱密码接入、状态查看、
  立即同步与断开；浏览器预览态如实置灰。

## 能力目录（技能 / MCP 预设）

控制面随版本发布一份只读目录，桌面端「从服务器装技能 / 浏览 MCP 预设」就是读它。
目录是公开内容（无用户数据），三个端点**匿名可读**；JSON 源在
`back/grey/src/main/resources/catalog/{skills,mcp}.json`，改内容随发版生效。

| 方法 | 路径                                        | 形状                                                                                  |
| ---- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| GET  | `/api/skills?q=`                            | **数组**：`[{ref, skill_id, name, installs, source, downloadable}]`（skills.sh 协议） |
| GET  | `/api/download/{owner}/{repo}/{skill}`      | `{files:[{path,contents}], hash}`                                                     |
| GET  | `/api/market/mcp/v0/servers?search=&limit=` | 官方 registry 同形：`{servers:[{server:{…}, _meta:{…}}]}`                             |

客户端接入方式（不需要改代码）：

- **技能**：控制面接入后（设置 → 控制面），技能面板的「发现」里会自动多一条
  **本控制面** 源——地址取自宿主 `control_plane_status`，token 不出宿主，无需手填。
  也可手动加自定义源（类型 `api`、地址填控制面根），或用 `GREYWORK_SKILLS_ORIGIN` 改默认源。
  搜索/下载经宿主转发（`skills_search` / `skills_download`），安装仍走两阶段落盘校验。
- **MCP**：MCP Registry 弹窗顶部新增 **Registry 地址**（跟随设置持久化，留空 = 官方向）；
  填 `http://<控制面>:8080/api/market/mcp` 即可浏览控制面预设。宿主侧同样可用
  `GREYWORK_MCP_REGISTRY_URL` 定默认值。登记仍只写本机服务器列表（MCP 进程由本机 npx/uvx 拉起）。

已验证的链路：搜索 → 下载快照（2 个文件，sha256 64 位）→ `skills_install` 落到
`<workspace>/.agents/skills/<id>` 并建 `.claude/skills` 兼容链接；MCP 目录返回可登记的 npm/pypi 条目。

### 运维台维护（/api/admin/catalog）

目录以库为准（`catalog_item`，V13）：首次启动从 `resources/catalog/*.json` **播种**，
之后只读写数据库 —— 改了、删了都不会被资源文件覆盖回去，也不需要重启或重新构建后端。

| 方法       | 路径                                      | 说明                                                               |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------ |
| GET        | `/api/admin/catalog?kind=all\|skill\|mcp` | 列表（不含正文）                                                   |
| GET        | `/api/admin/catalog/{id}`                 | 详情（技能的 files / MCP 的 packages）                             |
| POST / PUT | `/api/admin/catalog/skill[/{id}]`         | 新建 / 编辑技能                                                    |
| POST / PUT | `/api/admin/catalog/mcp[/{id}]`           | 新建 / 编辑 MCP 预设                                               |
| POST       | `/api/admin/catalog/{id}/enabled`         | 上下架（下架后公开端点搜不到、下载 404；已装到用户机器的不受影响） |
| DELETE     | `/api/admin/catalog/{id}`                 | 删除                                                               |

- 校验与宿主落盘规则同口径：skillId 小写 slug、ref 必须是 `owner/repo/skill` 且第三段等于 skillId、
  文件为相对路径、单文件 ≤256KB、≤128 个文件、必须有 `SKILL.md`；MCP 只接受 npm / pypi。
- **管理端 id 一律以字符串下发**：雪花 id 超过 2^53，浏览器 `JSON.parse` 会把它四舍五入，
  拿着截断后的 id 点编辑/删除必然 404。用户 / 设备 / 通道这几个视图同样按字符串下发。
- 每次增删改都写审计（`catalog_upsert` / `catalog_status` / `catalog_delete`，target = `catalog`）。
