import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * 运维台的单测只覆盖「纯逻辑 + 单组件」：格式化、HTTP 错误映射、会话存储、趋势图。
 *
 * 整页行为（登录、抽屉、弹窗）靠手工冒烟与后端契约测试兜底 —— 在这里把 Element Plus
 * 全量挂起来跑 DOM 测试，成本远大于收益。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
  },
});
