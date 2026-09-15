import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// 与 @greywork/workbench 同款约定，桌面壳层照搬，方便全仓统一心智：
//   tests/unit/**/*.test.ts       纯逻辑单测（node 环境）
//   tests/unit/**/*.dom.test.ts   组件测试（happy-dom 环境，.dom 后缀分流）
// 环境按文件后缀 + projects 配置分流，不再用 `// @vitest-environment` 文件头注释。
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
      // 只统计产品源码；vite-env.d.ts 是 ambient 声明不算字节。main.ts 是启动编排，
      // 有对应 dom 测试覆盖。测试本身在 tests/，天然不参与。
      // 2026-09-15 实测 statements 99 / branches 90.9 / functions 100 / lines 99，
      // 按实测留 ~10pt 余量登记（壳层小，主干全能测到，不值得留死空间）。
      include: ["src/**"],
      exclude: ["src/vite-env.d.ts"],
      thresholds: { statements: 90, lines: 90, branches: 80, functions: 90 },
    },
  },
});
