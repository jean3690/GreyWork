import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // barrel 出口与 ambient 声明不计入门禁；测试在 tests/，天然不参与。
      exclude: ["src/index.ts", "src/**/*.d.ts"],
      // 2026-09-15 实测 statements 89.58 / branches 82.6 / functions 83.33 / lines 89.58。
      thresholds: { statements: 80, lines: 80, branches: 72, functions: 73 },
    },
  },
});
