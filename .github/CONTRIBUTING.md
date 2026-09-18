# 贡献指南

## 环境

- Node >= 20（CI 用 24）、pnpm >= 9（`packageManager` 字段锁定 11.x，`corepack enable` 即可）
- Rust stable（仅桌面端 `apps/desktop/src-tauri` 需要）
- 首次：`pnpm install`（自动执行 husky 钩子安装）

## 常用命令

```bash
pnpm dev            # 桌面端开发（Tauri + 渲染层热更）
pnpm lint           # 全仓 ESLint
pnpm format         # Prettier 写入（format:check 仅校验）
pnpm typecheck      # 全 workspace vue-tsc
pnpm -r test        # 全部测试（带 test 脚本的 package 各自跑 vitest）
pnpm build          # 桌面端渲染层构建
```

Rust 侧（在 `apps/desktop/src-tauri` 下）：`cargo fmt` / `cargo clippy --all-targets -- -D warnings` / `cargo test`。

## 提交纪律（钩子强制）

- **pre-commit**：`lint-staged` 只对暂存文件跑 `eslint --fix` + `prettier`——违规代码会被自动修复或拦截
- **pre-push**：`pnpm lint && pnpm -r test` 全量门禁
- CI（`.github/workflows/ci.yml`）与本地钩子同构：lint / prettier / typecheck / test / build 拆成并行 job；Rust 侧 fmt → clippy → test

## 约定

- 提交信息：`<类型>: <摘要>`（feat/fix/refactor/chore/docs/test/ci）
- UI 改动必须附实测说明；架构与设计先读 `docs/architecture.md` 与 `docs/ui-design.md`
- 依赖升级走 dependabot PR，不手动改 lockfile
