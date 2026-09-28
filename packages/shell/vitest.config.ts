import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // barrel 出口不计入门禁
      exclude: ["src/index.ts", "src/**/*.d.ts"],
      // vitest 5 的 coverage-v8 改用 AST 精确重映射，数值较 v3 偏低；门槛按 5.x 实测重校（2026-09-28）。
      thresholds: { statements: 50, lines: 54, branches: 40, functions: 36 },
    },
  },
});
