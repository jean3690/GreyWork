/**
 * sidecar：拉起 headless 的 `greywork-server` 并等它就绪。
 *
 * Electron 只管「宿主壳」，领域逻辑（168 条命令）仍在 Rust 侧。做法是挑一个本机空闲端口起
 * `greywork-server`，让它同源同时提供 `/api/*` 与静态 SPA（`GREYWORK_STATIC_DIR` 指向已构建的
 * `apps/desktop/dist`），渲染层 loadURL 到它 → host-ipc 探到同源 `/api/health` 即进 "server"
 * 运行时模式，调用点零改动。
 *
 * 密码来源见 `auth.ts`：这里只接收 argon2 PHC 串，经 `GREYWORK_PASSWORD_HASH` 传给 sidecar，
 * **明文不进 env**。
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { app } from "electron";

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

/** 向内核要一个空闲 TCP 端口（绑 0 让 OS 分配）。 */
function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const probe = createServer();
  probe.unref();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = address !== null && typeof address === "object" ? address.port : 0;
    probe.close(() => (port ? resolve(port) : reject(new Error("无法分配端口"))));
  });
  return promise;
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
  const port = await freePort();
  const dataDir = path.join(app.getPath("userData"), "data");
  const child = spawn(serverBinaryPath(), [], {
    env: {
      ...process.env,
      // agent CLI 检测靠 PATH；补全登录 shell 的 PATH（见上）。
      PATH: userShellPath(),
      GREYWORK_BIND: `127.0.0.1:${port}`,
      GREYWORK_STATIC_DIR: staticDir(),
      GREYWORK_DATA_DIR: dataDir,
      GREYWORK_PASSWORD_HASH: passwordHash,
      // 本机可信宿主：sidecar 就绑在环回上、只服务本窗口。开启后服务端解除三处
      // 「网络暴露部署」的 fail-closed 加固 —— 不再钳制 ACP 沙箱/档位、放行
      // db_agents_sync、acp_start 改读 DB 里的后端目录（见 apps/server config::apply_trusted_host）。
      GREYWORK_TRUSTED_HOST: "1",
    },
    stdio: "inherit",
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
