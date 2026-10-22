/**
 * sidecar：拉起 headless 的 `greywork-server` 并等它就绪。
 *
 * Electron 只管「宿主壳」，领域逻辑（168 条命令）仍在 Rust 侧。做法是起一个
 * `greywork-server`，让它同源同时提供 `/api/*` 与静态 SPA（`GREYWORK_STATIC_DIR` 指向已构建的
 * `apps/desktop/dist`），渲染层 loadURL 到它 → host-ipc 探到同源 `/api/health` 即进 "server"
 * 运行时模式，调用点零改动。
 *
 * **端口必须跨启动稳定**：渲染层的持久化（工作区 `greywork.workspaces`、会话、设置……）全在
 * localStorage，而 localStorage 按 origin（协议 + 主机 + **端口**）隔离。以前每次
 * `listen(0)` 随机取端口 → 每次启动 origin 都变 → 读到的是一份空存储，用户表现为
 * 「工作区/设置每次都消失」。故这里改为固定端口：优先复用上次落盘的端口，被占用才顺延，
 * 顺延结果同样落盘，保证之后稳定。
 *
 * 密码来源见 `auth.ts`：这里只接收 argon2 PHC 串，经 `GREYWORK_PASSWORD_HASH` 传给 sidecar，
 * **明文不进 env**。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { app } from "electron";

import { SIDECAR_SPAWN_OPTIONS, sidecarEnv } from "../shared/sidecar-spec";
import { serverBinaryPath, staticDir } from "./paths";
import { resolveUserShellPath } from "./shell-path";

export interface Sidecar {
  readonly port: number;
  readonly process: ChildProcess;
}

let running: ChildProcess | null = null;

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * 默认端口。刻意落在 Linux/macOS/Windows 的**临时端口范围之下**（Linux 默认 32768-60999，
 * macOS/Windows 49152-65535），避免和内核分配出去做客户端连接的口撞上；固定端口一旦撞上就
 * 得顺延，而顺延会换 origin（见文件头注释），所以要尽量避开。
 */
const DEFAULT_PORT = 17844;
/** 端口被占用时最多顺延多少个（覆盖「上次的端口被别的进程临时占了」这类情况）。 */
const PORT_ATTEMPTS = 25;

/** 端口记忆文件：落盘在 userData 下，跨启动复用。 */
const portFile = (): string => path.join(app.getPath("userData"), "sidecar-port.json");

/** 读上次用的端口；无文件 / 损坏 / 越界返回 null。 */
function readPersistedPort(): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(portFile(), "utf8"));
    if (parsed && typeof parsed === "object") {
      const { port } = parsed as Record<string, unknown>;
      if (typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536) return port;
    }
  } catch {
    // 首启无文件 / 解析失败：忽略，走默认端口。
  }
  return null;
}

/** 记住本次端口，供下次启动复用（写失败不影响运行，只是下次可能换 origin）。 */
function persistPort(port: number): void {
  try {
    writeFileSync(portFile(), JSON.stringify({ port }));
  } catch (error) {
    console.warn("[sidecar] 端口记忆落盘失败（下次可能换 origin）：", error);
  }
}

/** 该端口现在能否绑定：绑一下立刻释放。 */
function isPortFree(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const probe = createServer();
  probe.unref();
  probe.once("error", () => resolve(false));
  probe.listen(port, "127.0.0.1", () => {
    probe.close(() => resolve(true));
  });
  return promise;
}

/** 从 preferred 起找第一个空闲端口；连续 PORT_ATTEMPTS 个都占用则报错。 */
async function pickPort(preferred: number): Promise<number> {
  for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
    const port = preferred + offset;
    if (port >= 65536) break;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`从 ${preferred} 起连续 ${PORT_ATTEMPTS} 个端口都被占用，无法起 sidecar`);
}

/** 轮询 `/api/health` 直到 200 或超时；子进程提前退出立刻失败，不白等满超时。 */
async function waitHealth(port: number, child: ChildProcess, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/api/health`;
  // 首轮立即请求，之后从 25ms 起步退避到 150ms。sidecar 通常 30ms 内就绪，
  // 固定 150ms 会把「已经起来」白等掉 100ms 以上（见启动打点）。
  let retryDelayMs = 25;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`greywork-server 启动后立即退出（code=${child.exitCode}）`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 还没起来，继续退避。
    }
    if (Date.now() > deadline) throw new Error(`sidecar 健康检查超时：${url}`);
    await delay(retryDelayMs);
    retryDelayMs = Math.min(150, Math.ceil(retryDelayMs * 1.6));
  }
}

/** 拉起 sidecar 并等它健康；返回端口与子进程句柄。 */
export async function startServer(passwordHash: string): Promise<Sidecar> {
  // 固定端口（跨启动稳定）：优先复用上次落盘的端口，被占用才顺延并重新落盘。
  const preferred = readPersistedPort() ?? DEFAULT_PORT;
  const port = await pickPort(preferred);
  if (port !== preferred) {
    console.warn(`[sidecar] 首选端口 ${preferred} 被占用，改用 ${port}；渲染层 origin 变化，localStorage 会另起一份`);
  }
  persistPort(port);
  const dataDir = path.join(app.getPath("userData"), "data");
  // agent CLI 检测靠 PATH；补全登录 shell 的真实 PATH（有缓存，见 shell-path.ts）。
  const shellPath = await resolveUserShellPath(process.env.PATH ?? "");
  const child = spawn(serverBinaryPath(), [], {
    env: sidecarEnv({
      base: process.env,
      shellPath,
      port,
      staticDir: staticDir(),
      dataDir,
      passwordHash,
    }),
    // stdio 见 SIDECAR_STDIO；windowsHide 让 Windows 不给 console 子系统程序分配新控制台
    // （否则双击桌面端会多弹一个终端）。
    ...SIDECAR_SPAWN_OPTIONS,
  });
  running = child;
  child.on("exit", (code) => {
    running = null;
    console.error(`[sidecar] greywork-server 退出，code=${code}`);
  });
  try {
    // spawn 失败（二进制缺失 / 无执行权限）走 'error' 事件，不会体现在 exitCode 上 ——
    // 不 race 的话要白等满 20s 健康检查超时。
    await Promise.race([
      waitHealth(port, child),
      new Promise<never>((_resolve, reject) => {
        child.once("error", (error) => reject(new Error(`无法启动 greywork-server：${error.message}`)));
      }),
    ]);
  } catch (error) {
    child.kill();
    if (running === child) running = null;
    throw error;
  }
  console.log(`[sidecar] greywork-server 就绪：http://127.0.0.1:${port}/`);
  return { port, process: child };
}

/** 终止 sidecar（应用退出时）。 */
export function stopServer(): void {
  running?.kill();
  running = null;
}
