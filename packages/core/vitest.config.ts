import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // barrel 出口与 ambient 声明不计入门禁；测试在 tests/，天然不参与。
      exclude: ["src/index.ts", "src/**/*.d.ts"],
      // 2026-09-15 实测 statements 74.6 / branches 88.09 / functions 95.83 / lines 74.6。
      // env/http/id 这些外壳工具按需触达，留 ~10pt 余量登记。
      thresholds: { statements: 65, lines: 65, branches: 78, functions: 85 },
    },
  },
});
