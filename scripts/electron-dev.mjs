#!/usr/bin/env node
/**
 * 一条命令起完整开发栈：先编 Node 宿主（apps/host-node），再起 Electron
 * （sidecar 由 Electron 自己 spawn）。
 *
 * 为什么脚本不自己常驻跑 server：
 * - sidecar 的端口是「跨启动稳定」的（默认 17844，落盘记忆），而渲染层的 localStorage 按
 *   origin 隔离。脚本另起一个 server 会和 Electron 抢端口，Electron 顺延到下一个端口后
 *   origin 就变了，用户表现为「设置 / 工作区又没了」。
 * - 所以这里只负责**编译**（这正是 `pnpm electron:dev` 缺的那一步），运行仍交给 Electron。
 *
 * 用法：
 *   node scripts/electron-dev.mjs              # 编译宿主 → pnpm electron:dev
 *   node scripts/electron-dev.mjs --skip-build # 跳过编译（刚编过，只要重启界面）
 *   node scripts/electron-dev.mjs --watch      # 宿主源码变动 → 重新编译 → 重启 Electron
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = new Set(process.argv.slice(2));
const skipBuild = flags.has("--skip-build");
const watchMode = flags.has("--watch");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const hostEntry = path.join(root, "apps", "host-node", "dist", "index.js");
const webIndex = path.join(root, "apps", "desktop", "dist", "index.html");

/** 监听宿主源码：.ts 与 command-manifest.json（命令契约是手工登记的快照）。 */
const WATCH_ROOTS = ["apps/host-node/src"];
const WATCH_EXTENSIONS = new Set([".ts", ".json"]);

function log(message) {
  console.log(`[dev-stack] ${message}`);
}

function fail(message) {
  console.error(`[dev-stack] ${message}`);
  process.exit(1);
}

if (flags.has("--help") || flags.has("-h")) {
  console.log("用法: node scripts/electron-dev.mjs [--skip-build] [--watch]");
  process.exit(0);
}

// --- 预检：缺东西要在编译前就说清楚，别等 sidecar 起来才报错 -----------------------------

if (!existsSync(webIndex)) {
  // sidecar 启动时会校验静态目录，缺 index.html 直接失败；dev 模式虽然走 Vite，也绕不过这道校验。
  fail(`缺少桌面端产物 ${path.relative(root, webIndex)}：先跑 pnpm build:desktop。`);
}

// --- 编译宿主 ---------------------------------------------------------------------------

function buildHost() {
  const started = Date.now();
  log("编译 Node 宿主（pnpm --filter @greywork/host-node build，增量通常几秒）…");
  const result = spawnSync(pnpm, ["--filter", "@greywork/host-node", "build"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    // Windows 上 pnpm 是 .cmd：Node 20+ 不许直接 exec，交给 shell 解析。
    shell: process.platform === "win32",
  });
  if (result.status !== 0) return false;
  log(`编译完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return true;
}

if (!skipBuild && !buildHost()) {
  fail("宿主编译失败，未启动 Electron（旧产物可能还在，修好后重跑即可）。");
}
if (skipBuild) {
  log(`跳过编译，直接用 ${path.relative(root, hostEntry)}（不存在会由 Electron 报 spawn 失败）`);
}

// --- Electron --------------------------------------------------------------------------

let electron = null;
let shuttingDown = false;
/** 这些子进程是被我们自己收掉的（重启 / 退出），它们的 exit 不该终止脚本。 */
const expectedExits = new Set();

function killElectron() {
  return new Promise((resolve) => {
    const child = electron;
    if (!child || child.exitCode !== null) {
      electron = null;
      resolve();
      return;
    }
    expectedExits.add(child);
    const done = () => resolve();
    child.once("exit", done);
    if (process.platform === "win32") {
      // Windows 没有进程组信号：taskkill /T 才能连 sidecar 一起收掉。
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    try {
      // detached 启动时 child 是进程组组长：发给 -pid 能同时收掉 Electron 与它 spawn 的 sidecar，
      // 否则 sidecar 会成孤儿占住固定端口（下次启动 origin 就变了）。
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

function startElectron() {
  log("启动 Electron（内部会 build 主进程并 spawn sidecar）…");
  electron = spawn(pnpm, ["electron:dev"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    // 单独进程组：见 killElectron 的注释。
    detached: process.platform !== "win32",
    // Windows 上 pnpm 是 .cmd（同 buildHost）。
    shell: process.platform === "win32",
  });
  const child = electron;
  child.on("exit", (code) => {
    if (electron === child) electron = null;
    // 重启流程里是我们自己杀的：交给 killElectron 的 Promise 处理，不要结束脚本。
    if (expectedExits.delete(child) || shuttingDown) return;
    log(`Electron 退出（code=${code ?? "signal"}），结束 dev-stack`);
    process.exit(code ?? 0);
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${signal}，关闭 Electron 与其 sidecar…`);
  await killElectron();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// --- watch：改宿主 → 重编 → 重启（渲染层热更由 Vite 负责，不需要重启整个界面） ---------

function collectDirs(target, out) {
  if (!existsSync(target)) return;
  if (!statSync(target).isDirectory()) {
    // 文件：监听它的父目录，事件里再按扩展名过滤。
    out.add(path.dirname(target));
    return;
  }
  out.add(target);
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    collectDirs(path.join(target, entry.name), out);
  }
}

function watchHostSources() {
  const dirs = new Set();
  for (const rel of WATCH_ROOTS) collectDirs(path.join(root, rel), dirs);
  let timer = null;
  let busy = false;
  let queued = false;

  const rebuildAndRestart = async () => {
    if (busy) {
      queued = true;
      return;
    }
    busy = true;
    log("检测到宿主源文件变动，重新编译…");
    const ok = buildHost();
    if (!ok) {
      log("编译失败，保留正在运行的旧进程；修好后保存文件即可重试");
    } else {
      await killElectron();
      if (!shuttingDown) startElectron();
    }
    busy = false;
    if (queued) {
      queued = false;
      timer = setTimeout(() => void rebuildAndRestart(), 200);
    }
  };

  for (const dir of dirs) {
    watch(dir, (_event, filename) => {
      if (!filename) return;
      if (!WATCH_EXTENSIONS.has(path.extname(String(filename)))) return;
      if (timer) clearTimeout(timer);
      // 保存文件常触发多次事件（编辑器写临时文件再改名），去抖后再动手。
      timer = setTimeout(() => void rebuildAndRestart(), 400);
    });
  }
  log(`watch 已开启：${dirs.size} 个目录（改动 .ts / .json → 重编并重启）`);
}

startElectron();
if (watchMode) watchHostSources();
