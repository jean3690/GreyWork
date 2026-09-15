import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // barrel 出口与 ambient 声明不计入门禁；测试在 tests/，天然不参与。
      exclude: ["src/index.ts", "src/**/*.d.ts"],
      // 2026-09-15 实测 statements 95.86 / branches 91.8 / functions 92.3 / lines 95.86。
      thresholds: { statements: 85, lines: 85, branches: 80, functions: 80 },
    },
  },
});
