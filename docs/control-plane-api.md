# 控制面接口一览（back/grey）

> 面向联调：按模块列出路径、认证要求与关键参数。请求/响应 DTO 以
> `back/grey/src/main/java/com/jean/grey/**/web/*Controller.java` 里的 `record` 为准；
> 运维面（`/api/admin/**`）单独见 [control-plane-auth.md](control-plane-auth.md)。

## 通用约定

- Base URL 默认 `http://localhost:8080`。
- 认证：`Authorization: Bearer <token>`（入场码 / 密码 / OIDC 三种登录最终都发同一种 token）。
- 未登录 → `401`；已登录但角色不够 `/api/admin/**` → `403`。
- 错误体：`{ "code": "snake_case", "message": "中文说明" }`；参数校验失败额外带 `fields`。
- 时间字段：服务端时区的 ISO-8601（`LocalDateTime`），不做 UTC 标记。
- 匿名可访问：`POST /api/auth/enroll`、`/api/auth/oidc/**`、`POST /api/channels/webhook/*`、
  `GET /api/market/packages|packages/{slug}|registry.json|download/**`、`/actuator/health`、
  `POST /api/admin/auth/login`、`/admin/**`（页面本身）。

## 认证与设备

| 方法   | 路径                                      | 认证 | 说明                                                           |
| ------ | ----------------------------------------- | ---- | -------------------------------------------------------------- |
| POST   | `/api/auth/enroll`                        | 匿名 | `{ code, email, displayName?, deviceName, platform }` → token  |
| GET    | `/api/auth/me`                            | 是   | 当前用户 + 当前设备（含 `role`）                               |
| POST   | `/api/auth/logout`                        | 是   | 撤销当前 token（204）                                          |
| DELETE | `/api/auth/sessions?includeCurrent=false` | 是   | 撤销其他设备（或全撤）的会话，回 `{ devices, currentRevoked }` |
| GET    | `/api/devices`                            | 是   | 当前用户的设备清单，含 `current` 标记                          |
| DELETE | `/api/devices/{id}`                       | 是   | 吊销指定设备（删行 + 撤会话）                                  |
| GET    | `/api/auth/oidc/providers`                | 匿名 | provider → 是否启用                                            |
| GET    | `/api/auth/oidc/{provider}/authorize`     | 匿名 | 302 到身份源；需 `redirect`（白名单内）                        |
| GET    | `/api/auth/oidc/{provider}/callback`      | 匿名 | 302 回客户端并附 `ticket`                                      |
| POST   | `/api/auth/oidc/exchange`                 | 匿名 | `{ ticket }` → 与 enroll 相同的 session                        |

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

## 插件市场

| 方法 | 路径                                               | 认证 | 说明                                       |
| ---- | -------------------------------------------------- | ---- | ------------------------------------------ |
| GET  | `/api/market/packages?q=&category=&page=&size=`    | 匿名 | 搜索已发布包                               |
| GET  | `/api/market/packages/{slug}`                      | 匿名 | 包详情 + 版本列表                          |
| POST | `/api/market/packages`                             | 是   | 建包（`slug/name/author/summary/...`）     |
| POST | `/api/market/packages/{slug}/versions`             | 是   | 发布版本（version/downloadUrl/sha256/...） |
| POST | `/api/market/packages/{slug}/versions/{v}/rollout` | 是   | `{ percent }` 灰度                         |
| POST | `/api/market/packages/{slug}/status`               | 是   | `{ status }` 上下架                        |
| GET  | `/api/market/registry.json?bucket=&channel=`       | 匿名 | 宿主消费的注册表（ETag / 304）             |
| GET  | `/api/market/download/{slug}/{version}`            | 匿名 | 302 到下载地址                             |

写入端点只允许包的所有者（`owner_user_id`）操作。

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
除用户 / 设备 / 入场码 / 通道 / 模型外，还有两块跨用户只读聚合：`GET /api/admin/storage`
（容量与对象明细）与 `GET /api/admin/automation`（任务、积压与执行失败率），对应用户侧接口
分别是「对象存储」与「自动化」两节。端点表、首次部署、故障排查见
[control-plane-auth.md](control-plane-auth.md)。
