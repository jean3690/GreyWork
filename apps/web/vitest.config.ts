import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// 与 @greywork/workbench 及 apps/desktop 同款约定，三个前端保持一套心智：
//   tests/unit/**/*.test.ts       纯逻辑单测（node 环境）
//   tests/unit/**/*.dom.test.ts   组件测试（happy-dom 环境，.dom 后缀分流）
// 环境按文件后缀 + projects 配置分流，不用 `// @vitest-environment` 文件头注释。
export default defineConfig({
  plugins: [vue()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
          exclude: ["tests/unit/**/*.dom.test.ts", "tests/unit/**/*.dom.test.tsx"],
          setupFiles: ["./tests/vitest.setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "happy-dom",
          include: ["tests/unit/**/*.dom.test.ts", "tests/unit/**/*.dom.test.tsx"],
          setupFiles: ["./tests/vitest.dom.setup.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      // 只统计产品源码；vite-env.d.ts 是 ambient 声明不算字节。本端是薄 bootstrap，
      // 产品源码只有 main.ts 与 App.vue 两个文件，两者都有对应的 dom 测试。
      include: ["src/**"],
      exclude: ["src/vite-env.d.ts"],
      // 与 apps/desktop 同档：壳层小、主干全能测到，不值得留死空间。
      thresholds: { statements: 90, lines: 90, branches: 80, functions: 88 },
    },
  },
});
