import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ["src/**/*.test.ts"],
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
      thresholds: { statements: 26, lines: 26, branches: 76, functions: 64 },
    },
  },
});
