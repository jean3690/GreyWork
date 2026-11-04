# 控制面认证与运维（back/grey）

> 面向自托管部署者：登录怎么走、角色怎么给、运维端点能做什么。
> 后端入口：`back/grey/src/main/java/com/jean/grey/auth/`（登录/角色）与
> `com/jean/grey/admin/`（概览/跨用户资源）；前端入口：`apps/admin/`。
> 业务接口（非运维面）见 [control-plane-api.md](control-plane-api.md)。

## 登录

三条路径（运维台密码 / 入场码 / OIDC），最终都落到 `AuthService.issueSession`：

| 方式     | 入口                                                                    | 凭据                                                      |
| -------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| 账号密码 | `POST /api/admin/auth/login` `{ email, password }`                      | **仅 admin 账号**；bcrypt 哈希存 `app_user.password_hash` |
| 入场码   | `POST /api/auth/enroll` `{ code, email, deviceName, platform }`         | 一次性码（默认 24h，`GREY_ENROLL_CODE` 或自动生成打日志） |
| OIDC     | `GET /api/auth/oidc/{provider}/authorize` → callback → `POST /exchange` | 身份源（配置见 `grey.oidc.providers`）                    |

管理员首次部署不需要先换入场码：启动时 `AdminCredentialBootstrap` 会为
`GREY_ADMIN_EMAILS` 里的每个邮箱建号（若不存在）、提为 admin、并写入初始密码。

```bash
GREY_ADMIN_EMAILS="ops@example.com"
GREY_ADMIN_PASSWORD="change-me-please"   # 留空则随机生成并打印到启动日志
```

- 已有密码的账号**不会被重启覆盖**；改密码走运维台「账户设置 → 修改密码」，或
  `POST /api/admin/auth/password`。
- 忘记密码：清掉库里的 `password_hash` 后重启（重新种初始密码），或用入场码登录
  取得 admin token 后调用修改密码接口。
- 密码登录失败与入场码失败**分开限流**（`grey:auth:admin-login-fail:*`），
  互不影响；失败文案统一为「邮箱或密码不正确」，不暴露账号是否存在。
- 运维台每次登录也登记一台设备（名称「运维台」、平台 `web`），同样受
  `GREY_MAX_DEVICES` 上限约束；超出时淘汰最久没用的那台，不影响其它客户端。

- 邮箱统一 trim + 小写，按 `LOWER(email)` 查找；`A@x.com` 与 `a@x.com` 是同一个账号。
- 入场码连续失败会限流：默认 10 次 / 10 分钟（`GREY_ENROLL_MAX_FAILURES`），只计失败、成功清零。
- 账号 `status` 非 `active`（或被逻辑删除）时：不能登录（403 `user_disabled`），存量 token 立即失效。

登录态是一枚不透明 token（Redis 里只存 sha256），`Authorization: Bearer <token>`。

- **TTL 是空闲超时**（默认 30 天 `grey.auth.session-ttl`）：设备有活动时随心跳（5 分钟节流）
  把 TTL 拉回满值，一直用的设备不会突然被登出；放着不用的会话照常过期。
- 撤销入口：`POST /api/auth/logout`（当前）、`DELETE /api/auth/sessions`（其他设备，
  `?includeCurrent=true` 全撤）、`DELETE /api/devices/{id}`（指定设备）、管理员禁用 / 踢下线。
- **设备数上限**（默认 20，`GREY_MAX_DEVICES`）：超出时淘汰最久没出现的设备并吊销其会话，
  避免反复重装攒出一堆设备行。
- `GET /api/auth/me` 回当前用户与设备（含 `role`）。

## 角色

只有两档：`user` / `admin`。管理员来源是**邮箱名单**：

```bash
GREY_ADMIN_EMAILS="ops@example.com,boss@example.com"
```

- 登录时按名单定角色（新账号建号即定，老账号回访补齐）；
- 启动时 `AdminBootstrap` 对已有账号再对齐一次，改完环境变量重启即可，不必重新登录；
- **只提不降**：从名单移除不会自动降级，避免手滑把自己锁在运维面外（降级要显式改库）。

`/api/admin/**` 需要 `ROLE_ADMIN`，其余接口只要登录。角色每次请求从库里读，改库下一次请求即生效。

## 运维台页面（Vue 3 + Vite）

浏览器打开 `/admin`（如 `http://localhost:8080/admin`）就是运维台：源码在
`apps/admin`，Vue 3 + TypeScript + Vue Router（hash）+ Pinia + Element Plus（暗色）。

页面：

| 页面       | 能做什么                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| 概览       | 用户 / 宿主 / 通道 / token / 审计五组指标，近 7 天趋势，最近 8 条运维动作 |
| 用户与设备 | 搜索、详情、启用禁用、升降角色、踢下线、逐台吊销设备                      |
| 入场码     | 按有效期签发（1h / 24h / 7d / 30d）、一键复制明文、撤销未使用的码         |
| 宿主       | 跨用户查看实例、在线状态、版本、承载通道数                                |
| 通道绑定   | 跨用户查看平台 / 账号 / 归属宿主 / 有效状态，管理员可硬停用               |
| 模型与用量 | 密钥元数据（密文不出库）、7 天请求与 token、按供应商拆分                  |
| 审计日志   | 按目标类型 / ID 过滤，offset 翻页                                         |

登录用账号密码，token 存 sessionStorage（关标签页即失效），退出会调
`/api/auth/logout` 回收。页面公开可取但**不含任何数据**：所有数据接口仍走
`/api/admin/**` 的 `ROLE_ADMIN` 门禁。

### 开发与构建

```bash
pnpm dev:admin     # http://localhost:5174/admin/，/api 代理到 8080
pnpm build:admin   # 产物写进 back/grey/src/main/resources/static/admin
```

- 构建产物随源码入库：`mvn package` 出来就是一个自带运维台的 jar，部署环境不需要 Node。
  改完前端记得重新 `pnpm build:admin` 并一起提交（哈希文件名会变）。
- 路由用 hash（`/admin/#/users`），所以服务端只需要把 `/admin`、`/admin/` 映射到
  `index.html`（见 `AdminPageController`），不需要 history fallback。
- 产物目录在 eslint / prettier 的忽略清单里，不要手动编辑 `static/admin/assets`。
- 换过产物哈希后再增量 `mvn package`，`target/classes` 会残留旧哈希文件；发布用
  `mvn clean package`，jar 里才只有当前这一份。

### 首次部署 / 演示流程

```bash
cd back/grey
GREY_ADMIN_EMAILS=admin@example.com \
GREY_ADMIN_PASSWORD=change-me-please \
./mvnw spring-boot:run        # 本地会经 compose 自动起 MySQL / Redis / RustFS
```

1. 打开 <http://localhost:8080/admin>，用上面的邮箱 + 密码登录；
2. 「概览」确认用户 / 宿主 / 通道 / token 四组数字都有值（空库时是 0，属正常）；
3. 「入场码」签发一枚 24h 码，复制给客户端完成首次 `/api/auth/enroll`；
4. 客户端登录后，用户与设备页能看到该账号；宿主页要等客户端注册宿主后才有数据；
5. 「审计日志」能看到刚才的签发、登录与启停动作。

改前端后：`pnpm build:admin` → 重新起后端（或 `mvn clean package` 后跑 jar）。

### 故障排查

| 现象                             | 先检查                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `/admin` 404 或白屏              | 是否跑过 `pnpm build:admin`；`static/admin/index.html` 引用的哈希文件是否存在         |
| 页面还在引用旧 JS                | 换过产物后用了增量 `mvn package`；改用 `mvn clean package`                            |
| 登录一直「邮箱或密码不正确」     | 密码只在首次启动时种入；看启动日志，或清空该账号 `password_hash` 重启                 |
| 登录 429                         | 同一来源连续失败触发限流；等待窗口（默认 10 分钟）或清 `grey:auth:admin-login-fail:*` |
| 接口 401                         | token 过期 / 被踢下线 / 账号被禁用；重新登录                                          |
| 接口 403                         | 当前账号不是 admin：检查 `GREY_ADMIN_EMAILS`，改完重启（`AdminBootstrap` 会补齐）     |
| 本地 dev 跨源报 CORS             | 正常应走 Vite 代理；直连后端时把前端源加进 `GREY_ALLOWED_ORIGINS`（PATCH 已放行）     |
| Flyway 启动失败（Duplicate key） | 迁移脚本被重复执行 / 改过已发布脚本；不要改历史版本，新增版本号                       |

## 运维端点

### 登录与概览

| 方法 | 路径                       | 说明                                                        |
| ---- | -------------------------- | ----------------------------------------------------------- |
| POST | `/api/admin/auth/login`    | 匿名；`{ email, password }` → `{ token, user, device }`     |
| POST | `/api/admin/auth/password` | 已登录管理员改密码；`{ currentPassword, newPassword }`      |
| GET  | `/api/admin/overview`      | 首页聚合（用户/设备/入场码/宿主/通道/模型/审计 + 7 天趋势） |

`/api/admin/overview` 的响应（字段名与 `apps/admin/src/types.ts` 一一对应）：

```json
{
  "users": { "total": 42, "active": 40, "disabled": 2, "admins": 2, "newToday": 3, "new7d": 11 },
  "devices": { "total": 57, "active24h": 12 },
  "codes": { "active": 4, "used": 18, "expired": 2, "issuedToday": 1 },
  "hosts": { "total": 6, "alive": 4, "bindings": 9 },
  "channels": { "total": 9, "active": 6, "degraded": 2, "disabled": 1 },
  "llm": { "keys": 3, "requests7d": 128, "tokens7d": 325400, "tokensToday": 12400 },
  "audit": { "today": 5, "total7d": 23 },
  "trend": [{ "date": "2026-11-03", "users": 3, "audits": 7, "llmRequests": 14 }],
  "recentAudits": [],
  "generatedAt": "2026-11-03T10:00:00"
}
```

7 天趋势固定在服务端时区（含今天）；`date` 是纯日期，前端不做时区换算。

### 用户

| 方法   | 路径                                                           | 说明                                                     |
| ------ | -------------------------------------------------------------- | -------------------------------------------------------- |
| GET    | `/api/admin/users?query=&limit=`                               | 按邮箱/昵称模糊搜，最多 200 条，按注册时间倒序           |
| GET    | `/api/admin/users/{id}/detail`                                 | 详情：设备数、最近活跃、注册来源                         |
| GET    | `/api/admin/users/{id}/devices`                                | 该用户的设备清单                                         |
| PATCH  | `/api/admin/users/{id}` `{ "status": "active" \| "disabled" }` | 禁用会连带吊销该用户全部会话；不能禁用自己               |
| PATCH  | `/api/admin/users/{id}` `{ "role": "admin" \| "user" }`        | 不能改自己；名单内邮箱不能降级；不能移除最后一个管理员   |
| DELETE | `/api/admin/users/{id}/sessions`                               | 踢下线：只清会话，账号保持 active；回 `{ "devices": n }` |
| DELETE | `/api/admin/users/{id}/devices/{deviceId}`                     | 吊销单台设备（归属校验在 service 层）                    |

### 资源

| 方法 | 路径                              | 说明                                                                          |
| ---- | --------------------------------- | ----------------------------------------------------------------------------- |
| GET  | `/api/admin/hosts`                | 跨用户宿主列表（在线状态来自 Redis 心跳）                                     |
| GET  | `/api/admin/channels`             | 跨用户通道绑定；`status` 是有效状态（含降级）                                 |
| POST | `/api/admin/channels/{id}/status` | `{ "status": "active" \| "disabled" }`，硬开关                                |
| GET  | `/api/admin/llm/keys`             | 密钥元数据（**不含密文**）                                                    |
| GET  | `/api/admin/llm/usage`            | 7 天 / 今日请求与 token，按供应商拆分                                         |
| GET  | `/api/admin/storage`              | 存储容量（只算 ready）、待确认上传、按种类分布、最近 100 个对象（带归属邮箱） |
| GET  | `/api/admin/automation`           | 任务数 / 启用数、到期积压与逾期未认领、7 天执行与失败数、最近 100 个任务      |

存储与自动化是**只读**视图：容量口径只含 `status=ready`（pending 是签了票据没回执的空壳，单独计数）；
逾期未认领 = `status=pending AND due_at < now`，它比 pending 总量更能说明调度是否卡住。

### 入场码

| 方法   | 路径                                                 | 说明                                                                  |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------------- |
| GET    | `/api/admin/enroll-codes`                            | 最近 100 条，只回 `hashPrefix`（前 8 位）与 `active / used / expired` |
| POST   | `/api/admin/enroll-codes` `{ "expiresInHours": 24 }` | 签发；**明文只在这次响应里出现一次**                                  |
| DELETE | `/api/admin/enroll-codes/{id}`                       | 只允许撤销未使用的码；用过的要保留作审计线索                          |

## 演示

答辩用的完整动线（准备 → 登录 → 签发入场码 → 用户/设备 → 通道 → 审计 → 收尾话术）见
[demo-walkthrough.md](demo-walkthrough.md)。

## 已知边界

- 没有 token 轮换：token 是固定串，靠滑动 TTL + 撤销入口控制生命周期；真要「换 token」得
  先有能持久化新 token 的客户端。
- 没有「记住我」与多因素：管理员密码是长期凭据，建议置于 TLS 反代之后；入场码本身
  仍是普通用户的第二因素。
- 没有邮箱验证：入场码本身就是准入门槛（`enroll` 会按邮箱建号）。
- 没有细粒度权限点：两档角色 + URL 前缀门禁；出现第三方协作用户再谈。
