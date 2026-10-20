/**
 * dev server（Vite）：起停渲染层热更服务，让 Electron 窗口载入它而非 sidecar 的静态产物。
 *
 * 形态与 `sidecar.ts` 对称：起一个子进程、等它就绪、退出时收掉。差别在于它是**开发专属**的 ——
 * 打包态永远不会走到这里（`isDevServerEnabled` 恒 false）。判定 / env / 参数的纯逻辑在
 * `shared/dev-server-spec.ts`，这里只做进程编排。
 *
 * Vite 的 `/api` 代理把请求转发给 sidecar（target 来自 `GREYWORK_SERVER_URL`，见 spec），所以
 * 窗口与 API 同源，`host-ipc` 判定为 "server" 态 —— 宿主能力不因换 origin 而缺失。
 */
import { spawn, type ChildProcess } from "node:child_process";

import { devServerArgs, devServerEnv, devServerOrigin, devServerPort } from "../shared/dev-server-spec";
import { desktopDir } from "./paths";
import { userShellPath } from "./sidecar";

export interface DevServer {
  readonly port: number;
  readonly origin: string;
  readonly process: ChildProcess;
}

let running: ChildProcess | null = null;
/** 是否是我们主动停的：用来把「正常收尾」与「意外退出」在日志里分开。 */
let stopping = false;

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * 起 Vite 前先清掉占用目标端口的残留进程（上一轮没干净退出的 vite / 卡死的孙进程）。
 *
 * dev 端口是钉死的（见 `dev-server-spec`）：dev 下只有我们自己在用，此刻的占用者必然是残留，
 * 杀掉即可自愈，不必让用户手动跑 `pnpm electron:dev:fresh`。跨平台：POSIX 用 `lsof` + `xargs kill`，
 * Windows 用 `netstat` + `taskkill`；任一命令缺失 / 失败都不影响后续（最多回到“端口仍被占”的
 * 明确报错）。清完稍等端口释放，避免紧接着的 spawn 又撞上。
 */
async function freeDevPort(port: number): Promise<void> {
  const command =
    process.platform === "win32"
      ? `for /f "tokens=5" %a in ('netstat -ano ^| findstr ":${port} " ^| findstr LISTENING') do taskkill /PID %a /T /F >nul 2>nul`
      : `lsof -ti tcp:${port} | xargs -r kill -TERM 2>/dev/null`;
  await new Promise<void>((resolve) => {
    const killer = spawn(command, { shell: true, stdio: "ignore" });
    killer.on("exit", () => resolve());
    killer.on("error", () => resolve());
  });
  await delay(500);
}

/**
 * 轮询 `origin` 直到 Vite 起来（HTTP 200）或超时。
 *
 * 就绪判定用 `GET /`：Vite 一 listen 就能返回 index.html，不必等首次请求触发依赖预构建。
 * 子进程先退出（多为 `--strictPort` 撞端口）要立刻失败，否则会白等满整个超时。
 */
async function waitReady(origin: string, child: ChildProcess, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Vite dev server 提前退出（code=${child.exitCode}）：多半是端口被占（--strictPort）。` +
          `试 \`pnpm electron:dev:fresh\` 清理残留，或用 GREYWORK_DEV_PORT 换端口。`,
      );
    }
    try {
      const response = await fetch(`${origin}/`);
      if (response.ok) return;
    } catch {
      // 还没起来，继续退避。
    }
    if (Date.now() > deadline) throw new Error(`Vite dev server 健康检查超时：${origin}`);
    await delay(200);
  }
}

/** 起 Vite dev server 并等它就绪；`sidecarPort` 用于把 `/api` 反代指过去。 */
export async function startDevServer(input: { sidecarPort: number }): Promise<DevServer> {
  const port = devServerPort(process.env);
  const origin = devServerOrigin(port);
  // 先清掉占用端口的残留 vite（上一轮没干净退出的），否则 --strictPort 会直接失败。
  await freeDevPort(port);
  // 单字符串 + shell:true：Windows 上 pnpm 是 .cmd 垫片，argv 形态直接 spawn 会失败。
  const command = `pnpm ${devServerArgs(port).join(" ")}`;
  const child = spawn(command, {
    cwd: desktopDir(),
    // GUI 会话继承的 PATH 常被截断（同 sidecar 的坑），补登录 shell 的真实 PATH。
    env: devServerEnv({ ...process.env, PATH: userShellPath() }, input.sidecarPort),
    shell: true,
    // POSIX：自成进程组，退出时能整组杀（见 stopDevServer）；Windows 靠 taskkill /T。
    detached: process.platform !== "win32",
    // stdin 关掉（Vite 不需要输入）；stdout/stderr 继承，日志直接打在启动 Electron 的终端里。
    stdio: ["ignore", "inherit", "inherit"],
  });
  stopping = false;
  running = child;
  child.on("error", (error) => console.error("[dev] 启动 vite 子进程失败：", error));
  child.on("exit", (code, signal) => {
    running = null;
    if (!stopping) console.error(`[dev] vite dev server 意外退出（code=${code}, signal=${signal}）`);
  });
  await waitReady(origin, child);
  console.log(`[dev] vite dev server 就绪：${origin}（/api → sidecar:${input.sidecarPort}）`);
  return { port, origin, process: child };
}

/** 终止 dev server（应用退出时）。 */
export function stopDevServer(): void {
  const child = running;
  running = null;
  if (!child || child.pid === undefined) return;
  stopping = true;
  if (process.platform === "win32") {
    // Windows 上 kill() 只杀 shell 垫片，孙进程会成孤儿 —— 用 taskkill 连树一起收。
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    // 负 pid = 整个进程组（detached 起的那一组），否则 pnpm/vite 的子进程会残留。
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // 已经退出了，无需处理。
    }
  }
}
