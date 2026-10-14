/**
 * 桌面端 dev server（Vite）的**纯规格**：常量与纯函数，脱开 Electron 与 `node:child_process`
 * 也能单测（与 `sidecar-spec.ts` 同构）。
 *
 * 存在的意义：dev 下让 Electron 窗口直接载入 Vite dev server，拿到渲染层 HMR；Vite 内置的
 * `/api` 代理把 `/api/*`（含 `/api/events` 的 WS）转发给 sidecar —— 于是窗口是**同源**的，
 * `host-ipc` 照常探到 `/api/health` 进 "server" 态，宿主能力一条不少。这里只放「端口 / origin /
 * 子进程 env 与参数」的判定，进程的起停与就绪探测在 `main/dev-server.ts`。
 *
 * **先有鸡还是先有蛋**：代理 target 取自 `GREYWORK_SERVER_URL`（Vite 启动时读取），而端口要等
 * sidecar 起来才知道。所以调用方必须先起 sidecar，再把端口喂给 [`devServerEnv`]。
 */

/** 逃生舱开关：置 `1` 时**不**起 Vite，改回载入 sidecar 托管的已构建 SPA（`apps/desktop/dist`）。 */
export const DIST_FLAG = "GREYWORK_ELECTRON_DIST";

/** dev 端口覆盖开关（非法值回落 [`DEFAULT_DEV_PORT`]）。 */
export const PORT_ENV = "GREYWORK_DEV_PORT";

/** dev server 端口，与 `vite-config` 的 `devPort` 缺省（1420）保持一致。 */
export const DEFAULT_DEV_PORT = 1420;

/**
 * 是否启用 dev server。
 *
 * 打包态恒 false（生产绝不 spawn Vite）；未打包时**默认开**，只有显式设 `GREYWORK_ELECTRON_DIST=1`
 * 才关 —— 这样 `pnpm electron:dev` 开箱即热更，而「验证已构建 SPA」这类场景有个明确出口。
 */
export function isDevServerEnabled(isPackaged: boolean, env: NodeJS.ProcessEnv): boolean {
  if (isPackaged) return false;
  return env[DIST_FLAG] !== "1";
}

/** dev 端口：`GREYWORK_DEV_PORT` 覆盖，非法（非整数 / 越界）回落缺省。 */
export function devServerPort(env: NodeJS.ProcessEnv): number {
  const raw = env[PORT_ENV];
  if (raw === undefined) return DEFAULT_DEV_PORT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_DEV_PORT;
}

/**
 * 渲染端在热更态要载入的 origin。
 *
 * 用 `127.0.0.1` 而非 `localhost`：与 cookie 的写入 host 必须逐字一致（cookie 按 host 存、
 * 端口无关），也避开 `localhost` 在 IPv6 环境解析成 `::1` 的歧义。`--host 127.0.0.1` 与之对齐。
 */
export function devServerOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** 非热更态的渲染端 origin：sidecar 同源托管（`loadURL` 与 cookie 都用它）。 */
export function sidecarOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Vite 子进程的环境变量：在 `base` 之上注入 `/api` 反代的 target，并**删掉 `TAURI_DEV_HOST`**。
 *
 * 后者是必须的：`vite-config` 见它就把 `server.host` 切成该值、HMR 另指 1421（那是 Tauri 时代
 * 的真机调试路径），与这里「同机 Electron 载 127.0.0.1」的场景相冲。
 */
export function devServerEnv(base: NodeJS.ProcessEnv, sidecarPort: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GREYWORK_SERVER_URL: `http://127.0.0.1:${sidecarPort}` };
  delete env.TAURI_DEV_HOST;
  return env;
}

/**
 * `pnpm` 之后的参数（命令串由 `main/dev-server.ts` 拼）。
 *
 * `--host 127.0.0.1` 覆盖 `vite-config` 的 `host:false`（默认只绑 localhost，且可能是 ::1）；
 * `--port` / `--strictPort` 显式钉死端口与「占用即失败」，不依赖配置漂移。
 */
export function devServerArgs(port: number): string[] {
  return ["exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"];
}
