# 控制面认证与运维（back/grey）

> 面向自托管部署者：登录怎么走、角色怎么给、运维端点能做什么。
> 代码入口：`back/grey/src/main/java/com/jean/grey/auth/`。

## 登录

两条路径，最终都落到 `AuthService.issueSession`：

| 方式   | 入口                                                                    | 凭据                                                      |
| ------ | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| 入场码 | `POST /api/auth/enroll` `{ code, email, deviceName, platform }`         | 一次性码（默认 24h，`GREY_ENROLL_CODE` 或自动生成打日志） |
| OIDC   | `GET /api/auth/oidc/{provider}/authorize` → callback → `POST /exchange` | 身份源（配置见 `grey.oidc.providers`）                    |

- 邮箱统一 trim + 小写，按 `LOWER(email)` 查找；`A@x.com` 与 `a@x.com` 是同一个账号。
- 入场码连续失败会限流：默认 10 次 / 10 分钟（`GREY_ENROLL_MAX_FAILURES`），只计失败、成功清零。
- 账号 `status` 非 `active`（或被逻辑删除）时：不能登录（403 `user_disabled`），存量 token 立即失效。

登录态是一枚不透明 token（Redis 里只存 sha256，默认 30 天 `grey.auth.session-ttl`）：
`Authorization: Bearer <token>`。`POST /api/auth/logout` 撤当前 token，`GET /api/auth/me` 回当前
用户与设备（含 `role`）。

## 角色

只有两档：`user` / `admin`。管理员来源是**邮箱名单**：

```bash
GREY_ADMIN_EMAILS="ops@example.com,boss@example.com"
```

- 登录时按名单定角色（新账号建号即定，老账号回访补齐）；
- 启动时 `AdminBootstrap` 对已有账号再对齐一次，改完环境变量重启即可，不必重新登录；
- **只提不降**：从名单移除不会自动降级，避免手滑把自己锁在运维面外（降级要显式改库）。

`/api/admin/**` 需要 `ROLE_ADMIN`，其余接口只要登录。角色每次请求从库里读，改库下一次请求即生效。

## 运维台页面

浏览器打开 `/admin`（如 `http://localhost:8080/admin`）就是运维台：同源单页，无构建、无外部依赖。

- 登录：填入场码 + 管理员邮箱，走的就是 `/api/auth/enroll`；角色不是 admin 会直接拒绝进后台。
  token 存 sessionStorage（关标签页即失效），点「退出」会调 `/api/auth/logout` 回收。
- 用户页：搜索（邮箱 / 昵称）、启用 / 禁用、踢下线，操作结果就地提示。
- 入场码页：选有效期签发（明文只显示这一次，可一键复制）、查看状态、撤销未使用的码。
- 页面公开可取但**不含任何数据**：所有数据接口仍走 `/api/admin/**` 的 `ROLE_ADMIN` 门禁。

## 运维端点

### 用户

| 方法   | 路径                                                           | 说明                                                     |
| ------ | -------------------------------------------------------------- | -------------------------------------------------------- |
| GET    | `/api/admin/users?query=&limit=`                               | 按邮箱/昵称模糊搜，最多 200 条，按注册时间倒序           |
| PATCH  | `/api/admin/users/{id}` `{ "status": "active" \| "disabled" }` | 禁用会连带吊销该用户全部会话；不能禁用自己               |
| DELETE | `/api/admin/users/{id}/sessions`                               | 踢下线：只清会话，账号保持 active；回 `{ "devices": n }` |

### 入场码

| 方法   | 路径                                                 | 说明                                                                  |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------------- |
| GET    | `/api/admin/enroll-codes`                            | 最近 100 条，只回 `hashPrefix`（前 8 位）与 `active / used / expired` |
| POST   | `/api/admin/enroll-codes` `{ "expiresInHours": 24 }` | 签发；**明文只在这次响应里出现一次**                                  |
| DELETE | `/api/admin/enroll-codes/{id}`                       | 只允许撤销未使用的码；用过的要保留作审计线索                          |

## 已知边界

- 没有 token 续期 / 轮换：到期重新登录；丢了设备用「踢下线」。
- 没有邮箱验证：入场码本身就是准入门槛（`enroll` 会按邮箱建号）。
- 没有细粒度权限点：两档角色 + URL 前缀门禁；出现第三方协作用户再谈。
