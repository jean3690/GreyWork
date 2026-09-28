import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // barrel 出口与 Tauri IPC 胶水（需桌面运行时）不计入门禁
      exclude: ["src/index.ts", "src/tauri-transport.ts", "src/**/*.d.ts"],
      // vitest 5 的 coverage-v8 改用 AST 精确重映射，数值较 v3 偏低；门槛按 5.x 实测重校（2026-09-28）。
      thresholds: { statements: 74, lines: 78, branches: 52, functions: 72 },
    },
  },
});
