import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // barrel 出口与 ambient 声明不计入门禁；测试在 tests/，天然不参与。
      exclude: ["src/index.ts", "src/**/*.d.ts"],
      // 2026-09-15 实测 statements 97.95 / branches 86.52 / functions 98.57 / lines 97.95。
      thresholds: { statements: 88, lines: 88, branches: 76, functions: 88 },
    },
  },
});
