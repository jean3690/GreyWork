# 运维台演示脚本（答辩用）

> 目标：在 10-15 分钟内把「控制面 + 运维台 + 审计」这条线走完整，且不依赖外网和真实 IM 账号。
> 所有命令都在仓库根执行，默认后端在 `http://localhost:8080`。

## 0. 准备

```bash
# 前端产物（只在改过 apps/admin 后需要；仓库里已带一份）
pnpm build:admin

# 起控制面：本地 compose 会自动拉起 MySQL / Redis / RustFS
cd back/grey
GREY_ADMIN_EMAILS=admin@example.com \
GREY_ADMIN_PASSWORD=DemoPass123 \
GREY_MASTER_KEY=$(openssl rand -base64 32) \
./mvnw spring-boot:run
```

启动日志里会打印一枚自动生成的入场码（`GREY_ENROLL_CODE` 留空时），复制备用。

检查：

```bash
curl -s http://localhost:8080/actuator/health
```

## 1. 登录运维台（约 1 分钟）

打开 <http://localhost:8080/admin>，用 `admin@example.com` / `DemoPass123` 登录。

讲解点：

- 这是独立 SPA（Vue 3 + Element Plus），产物打在控制面 jar 里，不是产品前端。
- 密码只存 bcrypt；登录会签发和客户端同一种 Bearer token，只是角色是 `admin`。
- token 在 sessionStorage，关标签页即失效。

## 2. 概览（约 2 分钟）

停在「概览」页：

- 五组指标：用户、宿主在线、通道异常、今日 token、今日审计。
- 7 天趋势：新增用户 / 审计动作 / 模型请求三条序列共用纵轴。
- 右侧显示通道状态分布与运行概况。
- 下方「最近运维动作」来自 `audit_log`。

空库时数字是 0，属正常；不要在这里停顿解释「为什么没有数据」，直接进入下一步制造数据。

## 3. 签发入场码 + 客户端入场（约 3 分钟）

在「入场码」页：

1. 有效期选 24 小时 → 「签发新码」；
2. 复制明文（只显示一次，库里是 sha256）；
3. 用 curl 模拟普通客户端入场：

```bash
curl -s -X POST http://localhost:8080/api/auth/enroll \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "刚才复制的入场码",
    "email": "demo@example.com",
    "displayName": "演示用户",
    "deviceName": "demo-laptop",
    "platform": "desktop"
  }'
```

响应里有 `token` 和 `user`。把它存下来：

```bash
TOKEN='粘贴上一步返回的 token'
curl -s http://localhost:8080/api/auth/me -H "Authorization: Bearer $TOKEN"
```

讲解点：

- 入场码一次性、24h 过期、失败有独立限流（10 次 / 10 分钟）。
- 同一邮箱会复用账号，设备单独登记；超过设备上限会淘汰最久没出现的那台。
- 角色来自邮箱名单，不是「第一个注册的人就是管理员」。

## 4. 用户与设备（约 3 分钟）

回到运维台「用户与设备」：

1. 搜索 `demo@example.com` → 打开「详情」抽屉：设备数、最近活跃、注册来源；
2. 在抽屉里「吊销」设备 → 客户端 token 立刻 401（可再用 curl 证明）；
3. 列表里「禁用」该用户 → 再调 `/api/auth/me` 仍是 401/403；
4. 「启用」恢复，再「踢下线」，账号仍可用、只是要重新登录。

讲解点：

- 禁用 = 账号不可用 + 连坐吊销全部会话；踢下线 = 只清会话，账号仍 active。
- 不能禁用自己、不能改自己的角色、不能移除最后一个管理员（后端硬守卫）。
- 名单内邮箱不能降权（否则下次登录会被 `RolePolicy` 提回来）。

## 5. 通道与宿主（约 2 分钟，可选）

如果客户端已注册宿主（`PUT /api/hosts/me`）并绑定过通道：

- 「宿主」页看在线状态、版本、承载通道数；
- 「通道绑定」页看有效状态（`degraded` = 宿主不在线，`disabled` = 管理员硬停用）；
- 点「停用」→ 平台 webhook 会回 409，再点「启用」恢复。

没有宿主也不影响主流程，直接说「这部分需要客户端在线，今天用只读数据展示」。

## 6. 模型与用量（约 1 分钟，可选）

- 「模型与用量」页只看元数据：供应商、标签、Base URL、最后使用时间；**密文不出库**。
- 供应商占比条来自 `llm_usage`；直连供应商（客户端自带 key）不计入。

## 7. 审计日志（约 2 分钟）

打开「审计日志」：

- 按目标类型 `user` / `enroll_code` / `channel` 过滤；
- 指出刚才的动作都在：签发入场码、禁用/启用、踢下线、吊销设备、运维台登录；
- 说明审计只追加、不软删，操作者邮箱是写入时快照。

## 8. 收尾话术

- 认证：密码 / 入场码 / OIDC 三条路径最终都走 `issueSession`，权限只有 URL 前缀
  `/api/admin/**` + `ROLE_ADMIN`。
- 数据：MySQL 存业务，Redis 存 token/心跳/限流，Flyway 管 schema。
- 前端：运维台与产品前端完全解耦，构建产物随 jar 发布，部署只需要 JRE + MySQL + Redis。

## 应急

| 情况                  | 处理                                                                                |
| --------------------- | ----------------------------------------------------------------------------------- |
| 8080 被占             | `SERVER_PORT=8081 ./mvnw spring-boot:run`，前端用 `GREY_PUBLIC_BASE_URL` 与代理对齐 |
| 想要全新数据          | `docker compose down -v`（会删本地库与对象存储卷）                                  |
| 忘记管理员密码        | 清空该账号 `app_user.password_hash` 后重启，或先用入场码换 token 调改密接口         |
| 运维台白屏            | 确认 `static/admin/index.html` 存在；`mvn clean package` 后重试                     |
| 演示时不方便手打 curl | 提前把命令贴在讲稿里，只替换入场码                                                  |
