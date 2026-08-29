import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ["src/**/*.test.ts"],
    // 环境策略：全局保持 node（多数用例是纯逻辑，node 更快也更贴近 store 的单测语义）。
    // 需要 DOM 的用例在文件头写 `// @vitest-environment happy-dom` 单独开启 ——
    // 组件挂载、以及 createWebHashHistory 这类依赖 window 的都走这条路。
    // 改全局 environment 会一次性扰动全部既有用例，故不做。
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // barrel 出口与纯类型不计入门禁；.vue 组件随基线棘轮逐步收紧
      exclude: ["src/index.ts", "src/types.ts", "src/**/*.d.ts", "src/i18n/**"],
      // 2026-08-26 二次重设基线：Codex 风格壳层改造新增 ShellSidebar/MarkdownText/StatusBar
      // 等视图组件（未挂测试），实测 statements/lines 26.75、branches 78.1、functions 67.1。
      // 2026-08-27 三次调整：H4 桥接新增 bridge.ts（含 22 个异步组件 lazy loader，仅真实渲染
      // 时执行，node 测试环境无法覆盖），pluginMarket.ts 补测后实测 statements/lines 26+、
      // branches 76+、functions 64.22。functions 阈值降至 64 保持棘轮。
      // 2026-08-29 四次上调：补齐 @vue/test-utils + happy-dom（此前组件层根本无法测试），
      // 新增 router/index.test.ts 与 ActivityPanel.test.ts。router 8.1% → 78.37%，
      // 全量 statements/lines 26 → 48.82、branches 79.55、functions 73.14。
      // 阈值提到实测下方约 1.5pt 留出余量，锁住增量防止回退。
      thresholds: { statements: 47, lines: 47, branches: 78, functions: 71 },
    },
  },
});
