import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // barrel 出口不计入门禁
      exclude: ["src/index.ts", "src/**/*.d.ts"],
      thresholds: { statements: 80, lines: 80, branches: 70, functions: 75 },
    },
  },
});
