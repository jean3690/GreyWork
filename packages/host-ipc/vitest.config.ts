import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // barrel 出口与 ambient 声明不计入门禁；测试在 tests/，天然不参与。
      exclude: ["src/index.ts", "src/**/*.d.ts"],
      // 2026-09-24 实测 statements 100 / branches 98.05 / functions 100 / lines 100。
      // 余下未覆盖的是防御性分支（events.ts 的「既无 WebSocket 又无 location」两种短路次序），留余量登记。
      thresholds: { statements: 90, lines: 90, branches: 88, functions: 95 },
    },
  },
});
