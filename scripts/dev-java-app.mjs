#!/usr/bin/env node
/**
 * 一条命令起「Java 控制面 + 桌面端」的开发环境。
 *
 *   pnpm dev:java-app                # Java(8080) + Electron（编 host-node，渲染层走 Vite 热更）
 *   pnpm dev:java-app --no-backend   # 复用已在跑的后端，只起桌面端
 *   pnpm dev:java-app --watch        # 额外监听 host-node 源码，改动后重编并重启 Electron
 *
 * 与既有脚本的区别：
 * - pnpm dev:all / start-dev.mjs：先构建产物再 electron:start，适合验证打包后的形态，不进热更新。
 * - pnpm dev:desktop-admin：桌面端 + 运维台 Vite(5174) + 后端；这里不要运维台。
 * - 本脚本只做两件事：确保 Java 就绪，然后把桌面端交给 scripts/electron-dev.mjs。
 *
 * Ctrl+C 只收本脚本启动的进程；默认用 start-only 生命周期，不顺手停掉 MySQL/Redis 容器。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const isWin = process.platform === "win32";
const pnpm = isWin ? "pnpm.cmd" : "pnpm";
const log = (message) => console.log("[dev-java-app] " + message);
// 抛出而不是 process.exit：main 的 finally 要负责收掉已启动的子进程。
const fail = (message) => {
  throw new Error(message);
};

function parseOptions(args) {
  const options = { help: false, noBackend: false, watch: false, timeoutMs: 180_000 };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--no-backend") options.noBackend = true;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--timeout") {
      const seconds = Number(args[++index]);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900) throw new Error("--timeout 需要 1-900 秒的整数");
      options.timeoutMs = seconds * 1000;
    } else throw new Error("未知参数，请使用 --help 查看用法");
  }
  return options;
}

/** 读 back/grey/.env；终端里已导出的变量优先，不覆盖。 */
function backendEnvironment(parent = process.env) {
  const file = path.join(root, "back/grey/.env");
  let saved = {};
  if (existsSync(file)) {
    try {
      saved = parseEnv(readFileSync(file, "utf8"));
    } catch {
      throw new Error("无法读取 back/grey/.env，请检查文件权限及格式");
    }
  }
  const env = { ...saved, ...parent };
  // 不自动停掉可能已在使用的 MySQL / Redis / RustFS；用户显式配置时遵循其设置。
  env.SPRING_DOCKER_COMPOSE_LIFECYCLE_MANAGEMENT ??= "start-only";
  return env;
}

function backendAddress(env) {
  const port = env.SERVER_PORT || "8080";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("SERVER_PORT 必须是 1-65535 的端口");
  const context = (env.SERVER_SERVLET_CONTEXT_PATH || "").replace(/\/+$/, "");
  const protocol = env.SERVER_SSL_ENABLED === "true" ? "https" : "http";
  let url;
  try {
    url = new URL(env.GREYWORK_CONTROL_URL || protocol + "://127.0.0.1:" + port + context);
  } catch {
    throw new Error("Java 后端地址不是合法 URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Java 地址只支持 HTTP(S)，且不能含账号密码");
  }
  return url.toString().replace(/\/+$/, "");
}

/** 桌面端不吃 Java 的命名空间，只拿最终地址；沿用 pnpm 的终端环境。 */
function appEnvironment(macAddress, parent = process.env) {
  const env = Object.fromEntries(
    Object.entries(parent).filter(
      ([key]) =>
        !key.startsWith("GREY_") &&
        !key.startsWith("SPRING_") &&
        key !== "SERVER_PORT" &&
        key !== "SERVER_SERVLET_CONTEXT_PATH" &&
        key !== "SERVER_SSL_ENABLED",
    ),
  );
  return { ...env, GREYWORK_CONTROL_URL: macAddress };
}

/** UP + 公共能力目录都通才算 GreyWork 控制面，避免把占用端口的其它程序当后端。 */
async function probeBackend(address) {
  const request = { signal: AbortSignal.timeout(2500), redirect: "error" };
  try {
    const health = await fetch(address + "/actuator/health", request);
    const state = await health.json().catch(() => null);
    // 启动中的 actuator 会回 503 + DOWN，别把它当成"别的服务占了端口"。
    if (state?.status === "DOWN") return "starting";
    if (!health.ok || state?.status !== "UP") return "foreign";
    const catalog = await fetch(address + "/api/skills?q=__greywork_startup_probe__", request);
    return catalog.ok && Array.isArray(await catalog.json().catch(() => null)) ? "ready" : "foreign";
  } catch {
    return "missing";
  }
}

function portAvailable(address) {
  const url = new URL(address);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, url.hostname.replace(/^\[|\]$/g, ""), () => server.close(() => resolve(true)));
  });
}

async function waitForBackend(address, { timeoutMs, onCheck }) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (onCheck && !onCheck()) throw new Error("Java 后端在就绪前退出了，请检查上面的 Maven 日志");
    const state = await probeBackend(address);
    if (state === "ready") return;
    if (state === "foreign") throw new Error("该地址不是健康的 GreyWork Java 控制面；不会关闭占用端口的现有服务");
    await delay(750);
  } while (Date.now() < deadline);
  throw new Error("等待 Java 后端超时，请检查 JDK 25、Docker/MySQL/Redis 和后端日志");
}

const children = new Map();
let shuttingDown = false;

function pipeWithPrefix(stream, name) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) console.log("[" + name + "] " + line);
  });
  stream.on("end", () => {
    if (buffer) console.log("[" + name + "] " + buffer);
  });
}

function startChild(name, command, args, cwd, env) {
  log("启动 " + name);
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // POSIX 上单独成组：收尾时按 -pid 能带走 mvnw 下的 java / Electron 下的 sidecar。
    detached: !isWin,
    shell: isWin && command.endsWith(".cmd"),
  });
  children.set(name, child);
  pipeWithPrefix(child.stdout, name);
  pipeWithPrefix(child.stderr, name);
  child.on("error", () => {
    children.delete(name);
    if (!shuttingDown) finish(1, name + " 无法启动，请检查所需命令和依赖");
  });
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (!shuttingDown) finish(code ?? 1, name + " 退出（" + (signal ?? "code=" + code) + "），一并关闭其余服务");
  });
  return child;
}

function stopChild(child, graceMs = 8000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const closed = new Promise((done) => child.once("close", done));
    if (isWin) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (isWin) child.kill();
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          // 已经退出。
        }
      }
    }, graceMs);
    timer.unref();
    void closed.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Electron 的 dev server（Vite 1420）是 detached 起的，只在自己 will-quit 里收；
 * 上层用信号杀 Electron 时会成孤儿并白占 CPU，这里补一刀。
 */
async function freeDesktopDevPort() {
  if (isWin) return;
  const port = process.env.GREYWORK_DEV_PORT || "1420";
  await new Promise((resolve) => {
    const killer = spawn("lsof -ti tcp:" + port + " | xargs -r kill -TERM 2>/dev/null", { shell: true, stdio: "ignore" });
    killer.once("exit", resolve);
    killer.once("error", resolve);
  });
}

function ensureDesktopDist() {
  const entry = path.join(root, "apps/desktop/dist/index.html");
  if (existsSync(entry)) return;
  log("缺少桌面端产物，先跑 pnpm build:desktop…");
  const result = spawnSync(pnpm, ["build:desktop"], { cwd: root, stdio: "inherit", env: process.env, shell: isWin });
  if (result.status !== 0) fail("桌面端产物构建失败，未启动任何服务");
}

let wake = () => {};
let exitCode = null;
function finish(code, message) {
  if (exitCode !== null) return;
  exitCode = code;
  if (message) console.error("[dev-java-app] " + message);
  wake();
}

async function main(args) {
  const options = parseOptions(args);
  if (options.help) {
    console.log(`用法：pnpm dev:java-app [选项]
  --no-backend   复用已在运行的 Java 后端，不在本脚本里启动 Maven
  --watch        监听 apps/host-node 源码，改动后重编并重启 Electron
  --timeout 秒数 后端就绪等待上限（默认 180 秒，首次拉依赖可调大）
  --help         查看帮助

前置：Node 22.22+、pnpm、JDK 25、Docker（或外部 MySQL/Redis）。
Java 配置读 back/grey/.env，终端环境变量优先；管理员密码 / 入场码见后端启动日志。`);
    return 0;
  }
  if (!existsSync(path.join(root, "node_modules"))) fail("前端依赖尚未安装，请先在仓库根目录运行 pnpm install");

  const backendEnv = backendEnvironment();
  const address = backendAddress(backendEnv);
  log("Java 地址：" + address + "；运维台 " + address + "/admin");

  // 先挂好退出信号与唤醒点，避免子进程在进入等待前就退出导致 main 永远挂住。
  const stopped = new Promise((resolve) => {
    wake = resolve;
    process.once("SIGINT", () => finish(0));
    process.once("SIGTERM", () => finish(0));
  });

  let code;
  try {
    if (options.noBackend) {
      const state = await probeBackend(address);
      if (state === "foreign" || state === "missing") fail("--no-backend 指定的后端不可用，请先自行启动或去掉该参数");
      if (state === "starting") await waitForBackend(address, { timeoutMs: options.timeoutMs });
      log("复用已有后端，退出时不会停止它");
    } else {
      const state = await probeBackend(address);
      if (state === "foreign") fail("地址被其他服务占用；不会自动结束现有进程，请先释放端口或改 SERVER_PORT");
      if (state === "ready") {
        log("复用已有后端，退出时不会停止它；改过 Java 源码请自行重启");
      } else {
        if (!(await portAvailable(address))) fail("Java 端口已占用但健康检查未通过；不会关闭现有进程");
        if (!existsSync(path.join(root, "back/grey/.env"))) log("未找到 back/grey/.env，沿用终端配置；首次使用可复制 .env.example");
        if (!backendEnv.GREY_ADMIN_EMAILS) log("未配置 GREY_ADMIN_EMAILS；需要运维台管理员时请补上");
        const backend = startChild(
          "Java 后端",
          isWin ? "mvnw.cmd" : "./mvnw",
          ["spring-boot:run"],
          path.join(root, "back/grey"),
          backendEnv,
        );
        await waitForBackend(address, { timeoutMs: options.timeoutMs, onCheck: () => backend.exitCode === null });
        log("Java 后端已就绪");
      }
    }

    ensureDesktopDist();
    const electronArgs = [path.join(root, "scripts/electron-dev.mjs")];
    if (options.watch) electronArgs.push("--watch");
    startChild("桌面端", process.execPath, electronArgs, root, appEnvironment(address));
    log("桌面端启动中；Ctrl+C 退出本次环境（只收本脚本启动的进程）");

    await stopped;
    code = exitCode ?? 0;
  } finally {
    shuttingDown = true;
    if (children.size > 0) {
      log("收尾：" + [...children.keys()].join(" / "));
      // 先停桌面端（它自己要收 Electron 与 sidecar），再停 Maven。
      for (const name of ["桌面端", "Java 后端"]) {
        const child = children.get(name);
        if (child) await stopChild(child);
      }
      await freeDesktopDevPort();
    }
  }
  return code;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("[dev-java-app] " + (error instanceof Error ? error.message : "启动失败"));
    process.exitCode = 1;
  });
