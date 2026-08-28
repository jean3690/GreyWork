<!-- 标题格式：<类型>: <一句话摘要>（如 feat: ACP 面板支持停止生成） -->

## 变更说明

<!-- 做了什么、为什么；关联 issue 用 Closes #N -->

## 变更范围

- [ ] packages/\*（monorepo 包）
- [ ] apps/desktop（Tauri / src-tauri）
- [ ] 文档 / CI

## 自查清单

- [ ] `pnpm lint` 通过（pre-commit 钩子已强制暂存区）
- [ ] `pnpm -r test` 通过（pre-push 钩子已强制）
- [ ] 涉及 UI：浏览器实测过浅色外壳与 shadcn 组件
- [ ] 涉及 Rust：`cargo clippy -- -D warnings` 通过
- [ ] 无新增依赖的重量级替代（遵循「删除重量代码」原则）

## 验证证据

<!-- 贴命令输出 / 截图；UI 变更必须附浏览器验证说明 -->
