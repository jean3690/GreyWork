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
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { app } from "electron";

import { SIDECAR_STDIO, sidecarEnv } from "../shared/sidecar-spec";
import { serverBinaryPath, staticDir } from "./paths";

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

/** 轮询 `/api/health` 直到 200 或超时。 */
async function waitHealth(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/api/health`;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 还没起来，继续退避。
    }
    if (Date.now() > deadline) throw new Error(`sidecar 健康检查超时：${url}`);
    await delay(150);
  }
}

/**
 * sidecar 可见的 PATH。
 *
 * 坑：从桌面图标（非终端）启动时，GUI 会话继承的 PATH 常被截断，不含 `~/.local/bin`、
 * nvm / npm 全局、`~/.cargo/bin` 等 —— 于是 server 的 agent CLI 探测按 PATH 找不到
 * claude / gemini，表现为「agent 列表为空」。这里用登录 shell 取真实 PATH（非 Windows），
 * 再兜底拼上常见用户 bin 目录，去重保序。
 */
export function userShellPath(): string {
  const base = process.env.PATH ?? "";
  if (process.platform === "win32") return base;
  const parts: string[] = [];
  const shell = process.env.SHELL;
  if (shell) {
    try {
      const out = execFileSync(shell, ["-lc", 'printf %s "$PATH"'], {
        timeout: 2000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) parts.push(out);
    } catch {
      // 取不到就只靠下面的常见目录兜底。
    }
  }
  const home = app.getPath("home");
  parts.push(
    base,
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".bun", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  );
  const seen = new Set<string>();
  const merged = parts
    .flatMap((entry) => entry.split(path.delimiter))
    .filter((dir) => dir && !seen.has(dir) && seen.add(dir));
  return merged.join(path.delimiter);
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
  const child = spawn(serverBinaryPath(), [], {
    env: sidecarEnv({
      base: process.env,
      // agent CLI 检测靠 PATH；补全登录 shell 的 PATH（见 userShellPath）。
      shellPath: userShellPath(),
      port,
      staticDir: staticDir(),
      dataDir,
      passwordHash,
    }),
    stdio: SIDECAR_STDIO,
  });
  running = child;
  child.on("exit", (code) => {
    running = null;
    console.error(`[sidecar] greywork-server 退出，code=${code}`);
  });
  await waitHealth(port);
  console.log(`[sidecar] greywork-server 就绪：http://127.0.0.1:${port}/`);
  return { port, process: child };
}

/** 终止 sidecar（应用退出时）。 */
export function stopServer(): void {
  running?.kill();
  running = null;
}
