# back/grey · GreyWork 控制面

Spring Boot 4 + MyBatis-Plus + MySQL + Redis 的**单用户自托管控制面**。它和仓库里的其它两套东西
是并列的，不是一个进程：

| 组件            | 语言       | 职责                                                             |
| --------------- | ---------- | ---------------------------------------------------------------- |
| `apps/electron` | TypeScript | 桌面壳                                                           |
| `apps/server`   | Rust       | 本地 / headless 宿主（命令面、ACP、工作区）                      |
| `back/grey`     | Java       | **控制面**：账号与设备、通道绑定、模型网关、存储、自动化、运维台 |

## 快速开始

想同时启动 Java 和桌面客户端，可在仓库根运行 `pnpm dev:all`；脚本读取本目录 `.env`，
等待后端就绪后构建并打开桌面应用。选项与进程清理说明见 [README-zh.md](../../README-zh.md#一键启动-java--桌面客户端)。

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

### 客户端 MCP / Skills 来源

客户端默认使用 Java 后端的公共能力目录（无需登录）：

- Skills 搜索：`GET /api/skills?q=…`；下载：`GET /api/download/{owner}/{repo}/{skill}`。
- MCP：`GET /api/market/mcp/v0/servers?search=…&limit=…`。登记后远程 MCP 使用其 URL，
  本地 npm / PyPI MCP 则由 agent 按启动配置运行，不把 Java 服务当作包管理器。
- 已在客户端接入账号时，默认来源自动跟随账号服务器；未接入时读取
  `GREYWORK_CONTROL_URL`，再回落 `http://127.0.0.1:8080`。
- 在运维台「能力目录」维护并启用自己的 Skills / MCP，即可被客户端搜索与安装/登记。
- 第三方依然可用：技能设置中启用 Skills Directory 或添加 API / GitHub 源；
  MCP 市场和设置共用 Registry 地址，可切换官方或自定义目录。新设置仅默认启用 Java 技能源，
  升级时保留已有第三方源及启用状态。
- `GREYWORK_SKILLS_ORIGIN` / `GREYWORK_MCP_REGISTRY_URL` 可单独覆盖宿主默认来源，
  客户端显式指定地址优先。Skills 安装记录保留实际下载地址，更新不会切换到当前账号的新服务器。
- 第三方请求不携带控制面 token；目录错误会展示给用户，不静默切换到其它市场。
- 旧版本未记录下载来源的技能，需要从原市场重新安装一次才能自动更新；不会猜测来源或
  因默认地址改变而覆盖成 Java 后端的同名内容。容器部署请将 `GREYWORK_CONTROL_URL` 设为
  容器内可达的 Java 服务地址，不能用宿主机的 `127.0.0.1`。

### 测试下载示例

已内置 3 个测试 Skills 和 2 个零依赖 MCP 包；搜索 `demo` 即可找到。测试 MCP 的 npm
`.tgz` 由 Java 后端直接提供，无需发布到 npm，也无需 API 密钥。普通第三方 MCP 预设仍保留。

| 类型  | 名称                    | 验证方式                                                                     |
| ----- | ----------------------- | ---------------------------------------------------------------------------- |
| Skill | `demo-hello`            | 使用技能后输出 `DEMO_SKILL_OK:demo-hello:v1`                                 |
| Skill | `demo-checklist`        | 安装后应有 `templates/checklist.md`，使用技能输出四项验收清单                |
| Skill | `demo-summary`          | 安装后应有 `references/output-format.md`，对提供的文字输出三行摘要           |
| MCP   | `io.greywork.demo/echo` | `demo_echo({"text":"你好 Java"})` 返回 `你好 Java`                           |
| MCP   | `io.greywork.demo/math` | `demo_add({"a":2,"b":3})` 返回 `5`；`demo_multiply({"a":6,"b":7})` 返回 `42` |

**现有数据库**不会因为修改种子文件而自动变化。启动时临时加上环境变量，补齐缺失示例：

```bash
GREY_CATALOG_IMPORT_DEMOS=true ./mvnw spring-boot:run
```

原有数据库连接、管理员等环境变量继续按正常启动配置提供。完成导入后关闭这个开关；
它不覆盖已编辑或停用的同名条目，但开关持续启用时，会在下次启动重新添加已删除的测试条目。
空数据库的首次启动会自动包含这些示例。下架示例可在运维台「能力目录」停用或删除，无需清空目录。

下载入口（默认本地 Java 后端）：

```text
http://127.0.0.1:8080/api/skills?q=demo
http://127.0.0.1:8080/api/download/greywork/tests/demo-hello
http://127.0.0.1:8080/api/market/mcp/v0/servers?search=demo
http://127.0.0.1:8080/api/market/mcp/packages/greywork-demo-echo-0.1.0.tgz
http://127.0.0.1:8080/api/market/mcp/packages/greywork-demo-math-0.1.0.tgz
```

客户端中：Skills 搜索 `demo` → 安装 → 新建 Agent 会话后明确指定技能；MCP 搜索 `demo`
→ 登记并保存 → 在设置中测试连接，再由 Agent 调用上述工具。MCP 真正下载发生在首次
`npx -y <Java 后端的 tgz 地址>` 启动时，后续可能使用 npm 缓存。MCP 运行需要 Node.js 22+ 和 npx。

MCP 包源码在 `src/main/resources/catalog/test-mcp/`。修改源码后，在仓库根运行
`pnpm market:test-packages`，再重建 Java 后端。更新已分发包时须同步提升 package.json 与目录
条目的版本/文件名，避免 npm 缓存复用旧包。若通过反向代理部署，确保 Spring 识别正确的外部
协议/Host/上下文路径，目录响应中的包地址会使用当前请求地址，而非写死 localhost。

### Java 统一模型网关

客户端「设置 → Agent → Java 统一模型网关」可使用当前账号在 Java 管理的模型；原来的本机
直连供应商仍保留，不会因为登录就自动切换模型。

1. 在账号页面接入 Java 服务器。
2. 在网关面板展开「向 Java 后端添加供应商密钥」，选择供应商、填写密钥并保存。
   Java 须已配置 `GREY_MASTER_KEY`；密钥加密存储于 Java，只需每账号配置一次，不需每设备重填。
   `anthropic` / `custom` 必须填写 OpenAI 兼容的上游 Base URL，本功能不转换 Anthropic 原生协议。
3. 刷新供应商，拉取模型或手动填写模型 ID，再点「选用此模型」。上游不支持 `/models` 不阻止手动接入。
4. 对话使用本机模型模式（不是外部 ACP CLI）；普通聊天支持 SSE 和非流式 JSON。
   要使用读写文件、Skills / MCP 等本机工具，先在供应商编辑区测试工具调用，再开启 Agent 模式。
   原有工作区授权与写入确认继续由宿主执行，Java 只转发模型请求。

供应商设置保存的是逻辑来源 `greywork://java/{provider}`，不是网络地址或 token。宿主按当前
账号确定 Java 地址，仅向固定的 `/v1/chat/completions`、`/v1/models` 注入账号凭据；前端的
自定义鉴权头和本机 key 不用于 Java 网关，也不跟随 HTTP 重定向。每轮对话固定账号，退出或
切换账号会取消在途请求；Java 账号 401 不会把旧对话回退到其他直连供应商。

新增读取接口：`GET /api/llm/providers` 仅返回当前账号的有效供应商名和标签；
`GET /v1/models` 需 `X-Grey-Provider`，只返回模型 ID，不透出上游 key 或额外响应字段。
聊天仍经原网关限流、选 key 与 usage 记账；token 统计以供应商实际返回的 usage 为准。
同一供应商下的多个有效密钥仍按后端规则轮换，应指向支持同一组模型的兼容上游。
聚合聊天、客户端远程助手的模型回复及宿主认领的云端单轮任务可使用此来源。
本轮不代理 embeddings、语音转写或外部 ACP CLI 登录，这些继续使用独立配置。

### 多设备显示偏好同步（首批）

入口在客户端「用户账号 → 多设备偏好同步」。目前仅手动同步 **主题、明暗模式、字号、圆角和语言**，
不会上传或覆盖工作区路径、密钥、权限档位、模型/MCP 配置和安装状态，也不会自动启用工具或提高权限。
云端定时任务已有 Java 统一存储，不再创建另一份同步副本。

1. 两台设备登录同一个 Java 账号。
2. 设备 A 调整显示偏好后，点击「推送本机偏好」。
3. 设备 B 点击「检查云端」查看差异；检查只读，不修改本机。确认后点击「应用云端偏好」。
4. 两台设备都修改过同一个版本时，后提交者会得到冲突。可确认应用云端，或者点击
   「保留本机并推送」。即使显式选择本机，仍需提交刚看到的版本号；云端再次更新会继续拒绝提交，
   没有绕过版本检查的强制覆盖接口。

应用云端前会重新读取版本并确认本机偏好没有变化；推送期间出现的新本机修改仍标为待同步。
换号或关闭同步面板后，旧请求的结果不会用于新账号。同步基线只在本机保存，按服务器地址和用户 ID 隔离。
云端删除标记不会重置本机设置；损坏或不兼容的快照不会应用。

专用接口为 `GET /api/sync/preferences` 和 `PUT /api/sync/preferences`，需账号 Bearer 认证。
它使用 `settings/client-preferences-v1` 对象，与旧 `/api/sync/changes` / `/objects/...` 协议并存：

```json
{
  "baseRevision": null,
  "payload": {
    "schemaVersion": 1,
    "theme": "codex",
    "colorMode": "dark",
    "fontSize": "medium",
    "radius": "small",
    "locale": "zh-CN"
  }
}
```

读取响应为 `{revision, deleted, payload}`，写入回执为 `{revision}`。新版接口的 revision 是十进制
**字符串**，不存在对象时为 `null`；客户端不能转成 JavaScript Number，否则雪花 ID 会丢精度。
Java 会校验并重新序列化偏好白名单，附带的私密字段不进入对象或历史。数据库更新带版本条件，
并发创建/更新失败返回 `409 sync_conflict`，事务回滚失败提交的历史记录。不需要新增或修改 Flyway 迁移。

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
