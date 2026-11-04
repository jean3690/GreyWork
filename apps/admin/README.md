# @greywork/admin · 运维台

控制面（`back/grey`）的管理端 SPA。**不是产品前端**：它不加载 `@greywork/workbench`，
也不进桌面端 / Web 端的产物，只服务部署者自己。

- 页面：概览、用户与设备、入场码、宿主、通道绑定、对象存储、自动化任务、模型与用量、审计日志
- 技术栈：Vue 3 + TypeScript + Vite + Vue Router（hash）+ Pinia + Element Plus（暗色）
- 后端契约：`/api/admin/**`，详见 [docs/control-plane-auth.md](../../docs/control-plane-auth.md)

## 开发

```bash
# 终端 1：起控制面（默认 8080）
cd back/grey
./mvnw spring-boot:run

# 终端 2（仓库根）：起运维台，5174，/api 代理到 8080
pnpm dev:admin
# → http://localhost:5174/admin/
```

登录用 `GREY_ADMIN_EMAILS` 里的邮箱 + `GREY_ADMIN_PASSWORD`；未配置密码时见后端首次启动日志。

## 构建

```bash
pnpm build:admin
```

产物**直接写进** `back/grey/src/main/resources/static/admin`，随后 `mvn clean package` 的 jar
就自带运维台，部署环境不需要 Node。

- 产物随源码入库，改完前端要重新 build 再提交；哈希文件名会变。
- `back/grey/target/classes` 是 Maven 的增量目录：换过哈希后再增量 package 会残留旧文件，
  发布统一用 `mvn clean package`。
- `static/admin/assets` 是生成物，已在 eslint / prettier 忽略清单里，不要手改。

## 目录

```
src/
├── api/            # fetch 封装、错误类型、sessionStorage 会话、所有 admin 端点
├── components/     # StatCard、TrendBars（纯 SVG/CSS，不引图表库）
├── layouts/        # 侧栏 + 顶栏 + 改密弹窗
├── router/         # hash 路由与登录守卫
├── stores/         # Pinia：当前管理员
├── styles/         # Element Plus 暗色变量覆盖 + 页内通用布局
├── utils/          # 时间/数字/平台/审计动作格式化、复制
└── views/          # 九个页面（登录 + 八个运维页）
```

## 约定

- **错误一律走 `ApiError`**：`code` / `message` / `status` 来自后端
  `{ code, message }`；401 会清会话并广播 `grey:admin-unauthorized`，`App.vue` 统一回登录页。
- **token 存 sessionStorage**：关标签页即失效，不留长期凭据。
- **复制不用 `navigator.clipboard`**：沿用全仓限制（桌面 WebView 会静默失败），走
  `utils/clipboard.ts` 的 textarea + `execCommand`。
- **中文文案直接写在模板里**：运维台只有中文，不接 i18n。
- **页面按路由懒加载**：除 `LoginView`（登录页）与 `AdminLayout`（外壳）外，所有视图都用
  `() => import(...)`；首屏只下外壳与登录页，进入运维台后每个页面切到才拉。`AdminLayout`
  用 `<Suspense>` 给了加载占位，慢链路上不会看起来像卡死。新页面沿用同一写法。
- **接口地址一律相对路径**（`/api/...`）：部署时把同源 `/api` 反代到控制面即可，不要写死后端域名；
  本地 dev 由 Vite 代理转发到 8080。
- **新增页面**：`views/XxxView.vue` → `router/index.ts` 加子路由（`meta.title` /
  `meta.subtitle`）→ `layouts/AdminLayout.vue` 加菜单项 → `api/index.ts` + `types.ts` 补契约。
- **表格 / 弹窗都交给 Element Plus**，不要拼 `innerHTML`：邮箱、昵称、通道账号都是用户输入。

## 验证

```bash
pnpm --filter @greywork/admin test        # vitest（happy-dom）
pnpm --filter @greywork/admin typecheck
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec eslint apps/admin
pnpm --filter @greywork/admin build
```

单测覆盖纯逻辑与单组件：`utils/format`、`utils/clipboard`、`api/http`（401 / 错误映射 /
网络失败）、`components/TrendBars`。整页行为（登录、抽屉、弹窗）靠手工冒烟，
后端契约由 `back/grey/src/test/java/com/jean/grey/ControlPlaneApiTest.java` 覆盖（含密码登录、
概览、资源门禁）。
