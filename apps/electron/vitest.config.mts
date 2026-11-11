import { defineConfig } from "vitest/config";

// 与 apps/host-node 同款约定：只跑本包 tests/ 下的单测。
// 不写 include 的话，缺省 glob 会把 apps/electron/build/host/tests/ 也收进来 —— 那是
// electron:host-bundle（pnpm deploy）摊出来的产物，解析不到仓库根的 tsconfig.base.json，
// 会在本地跑过 electron:prep 之后报一堆假红。
//
// 用 .mts 而非 .ts：本包没有 "type": "module"（out/ 是 CommonJS 主进程产物，不能加），
// .ts 会被 Vite 的 native config loader 当成 CJS 加载并告警，未来的 Vite 大版本会直接失败。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
