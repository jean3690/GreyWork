import { defineConfig } from "vitest/config";
import path from "path";
import vue from "@vitejs/plugin-vue";

// 对齐 GreyWork 的 tests/ 集中布局：
//   tests/unit/**/*.test.ts       纯逻辑单测（node 环境）
//   tests/unit/**/*.dom.test.ts   组件/hook 测试（happy-dom 环境，.dom 后缀分流）
//   src/features/**/__tests__/*.test.ts        附加节点逻辑单测（随 feature 目录存放）
//   src/features/**/__tests__/*.dom.test.ts    附加组件测试（随 feature 目录存放）
//   tests/vitest.setup.ts / tests/vitest.dom.setup.ts  各环境共享 setup
// 环境不再用 `// @vitest-environment` 文件头注释，而是按文件后缀 + projects 配置分流。
const srcRoot = path.resolve(__dirname, "src");

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": srcRoot,
    },
  },
  test: {
    projects: [
      // node 环境：纯逻辑单测
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/unit/**/*.test.ts", "src/features/**/__tests__/*.test.ts"],
          exclude: ["tests/unit/**/*.dom.test.ts", "tests/unit/**/*.dom.test.tsx", "src/features/**/__tests__/*.dom.test.ts"],
          setupFiles: ["./tests/vitest.setup.ts"],
        },
      },
      // happy-dom 环境：组件 / 依赖 window 的用例
      {
        extends: true,
        test: {
          name: "dom",
          environment: "happy-dom",
          include: ["tests/unit/**/*.dom.test.ts", "tests/unit/**/*.dom.test.tsx", "src/features/**/__tests__/*.dom.test.ts"],
          setupFiles: ["./tests/vitest.dom.setup.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      // 只统计业务源码；测试已移出 src，天然不参与。src/mocks 是测试夹具不是产品代码，
      // 100% 覆盖只会虚高总量（之前 fixtures 的 67 条语句被算进分母）。
      include: ["src/**"],
      exclude: ["src/index.ts", "src/types.ts", "src/**/*.d.ts", "src/i18n/**", "src/**/*.test.ts", "src/mocks/**"],
      // 2026-08-26 起基线注释见旧 vitest.config；测试迁移到 tests/ 后 coverage 只覆盖业务代码，
      // 数值重新测量后在此登记（见 2026-09-02 迁移说明）。
      // 2026-09-05 实测 statements 77.8 / branches 82.2 / functions 80.3 —— 原先 statements
      // 49 留了 ~29pt 死空间等于没设闸，收紧到 70 仍是余量充足的闸门。
      thresholds: { statements: 70, lines: 70, branches: 79, functions: 72 },
    },
  },
});
