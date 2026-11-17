# 贡献指南

## 环境

- Node >= 22.22.1（CI 用 24，见根 `engines`）、pnpm >= 9（`packageManager` 字段锁定 11.x，`corepack enable` 即可）
- 桌面端采用 Electron + Node 宿主，不再需要 Rust / Tauri 工具链
- Java 控制面开发另需 JDK 25 与 Docker，见 [back/grey/README.md](../back/grey/README.md)
- 首次：`pnpm install`（自动执行 husky 钩子安装）

## 常用命令

```bash
pnpm dev            # 桌面端渲染层 Vite 预览（无原生宿主）
pnpm dev:web        # 浏览器前端 Vite 预览
pnpm build:desktop  # 首次启动 Electron 前先生成静态入口
pnpm electron:dev:all # 编译 Node 宿主，再启动 Electron；--watch 监听宿主源码
pnpm dev:desktop-admin # 桌面端 + 运维台 + Java 控制面（--no-backend 可跳过控制面）
pnpm lint           # 全仓 ESLint + 圆角守卫（写死的 px 圆角会拦下）
pnpm format         # Prettier 写入（format:check 仅校验）
pnpm typecheck      # 全 workspace TypeScript / Vue 类型检查
pnpm test           # 全部测试（带 test 脚本的 package 各自跑 vitest）
pnpm build          # 桌面端与浏览器端渲染层构建
pnpm build:admin    # 运维台构建（写入 Java 控制面的静态资源目录）
```

单包校验可用 `pnpm --filter @greywork/host-node typecheck` / `test`；Java 控制面测试在
`back/grey` 下运行 `./mvnw test`（Testcontainers 需要 Docker）。

## 提交纪律（钩子强制）

- **pre-commit**：`lint-staged` 对暂存文件执行配置中的 ESLint / Prettier 检查与修复。
- **pre-push**：`pnpm lint && pnpm -r test` 全量门禁。
- CI（`.github/workflows/ci.yml`）另有独立的类型检查、渲染层构建 / 包体守卫、浏览器冒烟测试，
  以及 Linux / macOS / Windows 三平台 Electron 打包检查；本地钩子不代替这些构建检查。

## 约定

- 提交信息：`<类型>: <摘要>`（feat/fix/refactor/chore/docs/test/ci）
- UI 改动必须附实测说明；架构与设计先读 `docs/architecture.md` 与 `docs/ui-design.md`
- 依赖升级走 dependabot PR，不手动改 lockfile
