import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // barrel 出口与 Tauri IPC 胶水（需桌面运行时）不计入门禁
      exclude: ["src/index.ts", "src/tauri-transport.ts", "src/**/*.d.ts"],
      thresholds: { statements: 80, lines: 80, branches: 70, functions: 75 },
    },
  },
});
