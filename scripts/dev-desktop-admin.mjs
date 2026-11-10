#!/usr/bin/env node
/**
 * 一条命令起「桌面端 + 管理端 + Java 控制面」的开发环境。
 *
 *   node scripts/dev-desktop-admin.mjs                 # 三件套全起
 *   node scripts/dev-desktop-admin.mjs --no-backend    # 只起桌面端 + 运维台前端
 *   node scripts/dev-desktop-admin.mjs --build-desktop # 强制重编渲染层（默认只在 dist 缺失时编）
 *
 * 桌面端不是 `pnpm dev:desktop`（那只是 Vite 预览）：Electron 的 sidecar 校验并托管
 * apps/desktop/dist，所以这里走 scripts/electron-dev.mjs —— 它负责编 host-node 再拉起 Electron。
 * 管理端是独立的 Vite 服务（5174，base=/admin/），/api 代理到 8080。
 * 控制面是 back/grey 的 `./mvnw spring-boot:run`：spring-boot-docker-compose 会顺手拉起
 * MySQL / Redis / RustFS（前置 JDK 25 + Docker），运维台登录与数据都靠它。
 *
 * 三路子进程都独立成组：一个挂了/Ctrl+C 时整组收掉，别留 sidecar、mvn、compose 容器乱跑。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = new Set(process.argv.slice(2));
const withBackend = !flags.has("--no-backend");
const forceBuildDesktop = flags.has("--build-desktop");
const isWin = process.platform === "win32";
const pnpm = isWin ? "pnpm.cmd" : "pnpm";
const webIndex = path.join(root, "apps", "desktop", "dist", "index.html");
/** Electron 自己起的 Vite 端口（与 apps/electron 的 dev-server-spec 保持一致）。 */
const desktopDevPort = Number(process.env.GREYWORK_DEV_PORT) || 1420;

if (flags.has("--help") || flags.has("-h")) {
  console.log(`用法: node scripts/dev-desktop-admin.mjs [--no-backend] [--build-desktop]

  --no-backend      不起控制面（back/grey，8080），只跑桌面端 + 运维台前端
  --build-desktop   启动前重编桌面端渲染层（默认只在 apps/desktop/dist 缺失时编）`);
  process.exit(0);
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const COLORS = { desktop: "36", admin: "35", backend: "33" };

function log(message) {
  console.log(`[dev-desktop-admin] ${message}`);
}

function fail(message) {
  console.error(`[dev-desktop-admin] ${message}`);
  process.exit(1);
}

/** 子进程输出加前缀：几路服务同时刷屏时才分得清谁是谁。 */
function pipeWithPrefix(stream, name) {
  const tag = useColor ? `\x1b[${COLORS[name]}m[${name}]\x1b[0m ` : `[${name}] `;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) console.log(tag + line);
  });
  stream.on("end", () => {
    if (buffer) console.log(tag + buffer);
  });
}

// --- 桌面端渲染层：Electron 的 sidecar 直接托管 dist，缺了会启动失败 -----------------------

if (forceBuildDesktop || !existsSync(webIndex)) {
  log(`编译桌面端渲染层（${forceBuildDesktop ? "强制" : "缺少 dist"}）…`);
  const result = spawnSync(pnpm, ["build:desktop"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: isWin,
  });
  if (result.status !== 0) fail("桌面端渲染层编译失败，未启动任何服务。");
}

// --- 子进程管理 -------------------------------------------------------------------------

const children = new Map();
let shuttingDown = false;

function start(name, command, args, cwd) {
  log(`启动 ${name}: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: useColor ? "1" : "0" },
    // POSIX 上单独成组，退出时按 -pid 整组收（Electron 还带着 sidecar、mvn 还带着 java）。
    detached: !isWin,
    shell: isWin,
  });
  children.set(name, child);
  pipeWithPrefix(child.stdout, name);
  pipeWithPrefix(child.stderr, name);
  child.on("error", (error) => fail(`${name} 启动失败: ${error.message}`));
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (shuttingDown) return;
    log(`${name} 退出（${signal ?? `code=${code}`}），一并关闭其余服务`);
    void shutdown(code ?? 1);
  });
}

/**
 * 收尾时清掉占着桌面 dev 端口的残留 Vite。
 *
 * Electron 的 Vite 是 detached 起的、且只在自己 will-quit 里收（apps/electron dev-server.ts）：
 * 上层脚本用信号杀 Electron 时走不到那段，Vite 会成孤儿。它下次启动前虽然会自清，
 * 但留着白占 CPU，所以这里补一刀。Windows 上 taskkill /T 已连整棵树收掉，不需要。
 */
async function freeDesktopDevPort() {
  if (isWin) return;
  await new Promise((resolve) => {
    const killer = spawn(`lsof -ti tcp:${desktopDevPort} | xargs -r kill -TERM 2>/dev/null`, {
      shell: true,
      stdio: "ignore",
    });
    killer.on("exit", () => resolve());
    killer.on("error", () => resolve());
  });
}

function killChild(name, child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const done = () => resolve();
    child.once("exit", done);
    if (isWin) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // 已经退出。
      }
    }, 5000).unref();
  });
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  const running = [...children.entries()];
  if (running.length > 0) {
    log(`关闭 ${running.map(([name]) => name).join(" / ")}…`);
    await Promise.all(running.map(([name, child]) => killChild(name, child)));
  }
  await freeDesktopDevPort();
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

// --- 启动 -------------------------------------------------------------------------------

log(`仓库根: ${root}`);
log("管理端 http://localhost:5174/admin/（/api → http://localhost:8080）");
log("桌面端 Electron 窗口由 sidecar 托管渲染层（默认端口 17844）");
if (withBackend) {
  log("控制面 http://localhost:8080/admin（mvnw 首次启动会经 compose 起 MySQL/Redis/RustFS；管理员密码见其日志）");
} else {
  log("提示：已跳过控制面（--no-backend），管理端登录与数据会 401 / 连不上");
}

start("admin", pnpm, ["--filter", "@greywork/admin", "dev"], root);
// electron-dev.mjs 自己编 host-node 并管理 Electron/sidecar 的整组退出。
start("desktop", process.execPath, [path.join("scripts", "electron-dev.mjs")], root);
if (withBackend) start("backend", isWin ? "mvnw.cmd" : "./mvnw", ["spring-boot:run"], path.join(root, "back", "grey"));
