/**
 * 跨语言 ACP 门禁的专用配置（`pnpm --filter @greywork/acp test:integration`）。
 *
 * 与 `vitest.config.ts`（单元测试）刻意分开：
 *   - 这条测试会 spawn 真实的 `target/debug/greywork-server`，所以**不能**进 `pnpm -r test`
 *     —— 那个 job 没有 Rust 编译产物，也不该为它多编译一次服务端。
 *   - 不开 coverage：它不是靠覆盖率守的，且与单元测试的阈值门槛无关（阈值是按 `src/**` 重校过的）。
 *   - `fileParallelism: false`：它独占一个固定端口并 spawn 进程，自己和自己并行没有意义。
 *   - 超时给到 60s：agent 启动 + 握手 + 一轮 prompt 在本机是几百毫秒级，留足余量即可；
 *     刻意低于宿主 `PERMISSION_CONFIRM_TIMEOUT`（120s），这样将来 mock agent 万一开始问权限，
 *     是在这里 60s 断言失败，而不是挂到两分钟。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
