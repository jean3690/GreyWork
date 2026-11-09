# back/grey · GreyWork 控制面

Spring Boot 4 + MyBatis-Plus + MySQL + Redis 的**单用户自托管控制面**。它和仓库里的其它两套东西
是并列的，不是一个进程：

| 组件            | 语言       | 职责                                                                       |
| --------------- | ---------- | -------------------------------------------------------------------------- |
| `apps/electron` | TypeScript | 桌面壳                                                                     |
| `apps/server`   | Rust       | 本地 / headless 宿主（命令面、ACP、工作区）                                |
| `back/grey`     | Java       | **控制面**：账号与设备、通道绑定、模型网关、存储、自动化、运维台           |

## 快速开始

前置：JDK 25、Docker（本地库用 `compose.yaml` 自动拉起）。

```bash
cd back/grey

# 1) 起控制面：spring-boot-docker-compose 会自动起 MySQL / Redis / RustFS
GREY_ADMIN_EMAILS=admin@example.com \
GREY_ADMIN_PASSWORD=change-me-please \
./mvnw spring-boot:run
```

- 控制面：<http://localhost:8080>
- 运维台：<http://localhost:8080/admin>（账号 `admin@example.com` / 上面的密码）
- 首次启动日志里还会打印自动生成的**入场码**（`GREY_ENROLL_CODE` 留空时），供普通客户端登录
- 未配置 `GREY_ADMIN_PASSWORD` 时，管理员初始密码也会随机生成并打印到日志，只打印一次
- 要演示模型密钥 / 网关，再补一个 `GREY_MASTER_KEY=$(openssl rand -base64 32)`；
  不配也能启动，只是存取供应商 key 的接口会回 `master_key_missing`

不想用内置 compose 时，自行准备 MySQL 8 / Redis 7，并用
`SPRING_DATASOURCE_URL` / `SPRING_DATASOURCE_USERNAME` / `SPRING_DATASOURCE_PASSWORD` /
`SPRING_DATA_REDIS_HOST` / `SPRING_DATA_REDIS_PORT` 指过去。完整变量见
[.env.example](.env.example)。

## 运维台

源码在 `apps/admin`（不在这个目录里）。构建产物已随源码入库，**直接跑后端就能打开**；
改过前端后需要：

```bash
pnpm build:admin     # 在仓库根执行，产物写进 src/main/resources/static/admin
```

开发时用 `pnpm dev:admin`（5174，`/api` 代理到 8080）。页面、端点与权限模型见
[docs/control-plane-auth.md](../../docs/control-plane-auth.md)；前端约定见
[apps/admin/README.md](../../apps/admin/README.md)。

## 打包

```bash
./mvnw clean package
java -jar target/grey-0.0.1-SNAPSHOT.jar
```

- 用 **clean**：`target/classes` 是增量目录，前端换过哈希后会残留旧 asset。
- jar 自带运维台（`BOOT-INF/classes/static/admin`），部署环境只需要 JRE 25 + MySQL + Redis。
- 当前仓库没有控制面的 Dockerfile；容器化时把 `target/*.jar` 拷进 `eclipse-temurin:25-jre`
  即可，健康检查打 `/actuator/health`。

## 测试

```bash
./mvnw test
```

- `ControlPlaneApiTest` 用 Testcontainers 起 MySQL 8.4 / Redis 7 / RustFS，覆盖认证、同步、
  宿主、通道、模型网关、存储、自动化、运维面（含密码登录、概览、资源门禁）。
  首次运行需要拉镜像，之后走本地缓存。
- `Cron5Test` 是纯单元测试。
- 只想跑运维面相关：`./mvnw -Dtest=ControlPlaneApiTest test`。

## 数据库迁移

Flyway，脚本在 `src/main/resources/db/migration/V1 ... V11`，启动时自动执行。

- **已发布过的迁移不要改**：Flyway 校验 checksum，改了会直接拒绝启动；新增变更一律开新版本。
- V9 角色、V10 审计与设备运维、V11 管理员密码列。
- 初始化数据由启动器负责（`AdminBootstrap` 提权、`AdminCredentialBootstrap` 建号种密码），
  不写 seed SQL。

## 配置

| 变量                   | 默认             | 说明                                            |
| ---------------------- | ---------------- | ----------------------------------------------- |
| `GREY_ADMIN_EMAILS`    | 空               | 管理员邮箱名单（逗号分隔）                      |
| `GREY_ADMIN_PASSWORD`  | 空               | 运维台初始密码；空则随机打印日志                |
| `GREY_ENROLL_CODE`     | 空               | 普通客户端入场码；空则随机打印日志              |
| `GREY_MASTER_KEY`      | 空               | 加密用户模型 key（32 字节 base64）              |
| `GREY_ALLOWED_ORIGINS` | `localhost:5173` | 跨源前端白名单；本地 dev 走 Vite 代理时不需要   |
| `GREY_S3_*`            | 关闭             | 对象存储；未启用时上传接口回 `storage_disabled` |
| `SPRING_DATASOURCE_*`  | compose 注入     | 独立部署时的 MySQL 连接                         |
| `SPRING_DATA_REDIS_*`  | compose 注入     | 独立部署时的 Redis                              |

其余（LLM 限额、自动化、OIDC）见 [.env.example](.env.example) 与
`src/main/resources/application.yml`。

## 接口约定

- 认证：`Authorization: Bearer <token>`；`/api/admin/**` 需要 `ROLE_ADMIN`。
- 错误统一为 `{ "code": "snake_case", "message": "中文说明" }`，校验失败额外带 `fields`。
- 时间字段是服务端时区的 ISO-8601（`LocalDateTime`），前端只负责格式化。
- 模块：`auth` / `account` / `host` / `channel` / `llm` / `automation` / `storage` / `sync` / `admin`。
- 按模块的路径与参数速查：[docs/control-plane-api.md](../../docs/control-plane-api.md)。

## 目录

```
src/main/java/com/jean/grey/
├── auth/          # 登录（密码 / 入场码 / OIDC）、token、角色、审计、限流
├── account/       # 用户、设备、运维面的用户管理
├── admin/         # 运维台聚合：概览、跨用户资源视图
├── host/          # 宿主注册与心跳
├── channel/       # IM 通道绑定与 webhook 入站
├── llm/           # 供应商 key、网关、用量与配额
├── automation/    # cron 任务、队列、运行记录
├── storage/       # S3 预签名上传下载
├── sync/          # 多端增量同步
├── config/        # Security / MyBatis / 属性绑定
└── common/        # ApiException、错误处理、哈希与邮箱工具
```
