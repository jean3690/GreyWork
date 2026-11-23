#!/usr/bin/env node
/** 一键启动 Java + 桌面客户端；复用健康后端，清理仅限本脚本新建的进程组。 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const isWin = process.platform === "win32";
const pnpm = isWin ? "pnpm.cmd" : "pnpm";
const log = (message) => console.log(`[start-dev] ${message}`);

export function parseOptions(args) {
  const options = { help: false, noBackend: false, backendOnly: false, skipBuild: false, backendUrl: null, timeoutMs: 180_000 };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--no-backend") options.noBackend = true;
    else if (arg === "--backend-only") options.backendOnly = true;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--timeout") {
      const seconds = Number(args[++index]);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900) throw new Error("--timeout 需要 1–900 秒的整数");
      options.timeoutMs = seconds * 1000;
    } else if (arg === "--backend-url") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("--backend-url 需要一个 HTTP(S) 地址");
      options.backendUrl = value;
    } else throw new Error("未知启动参数，请使用 --help 查看用法");
  }
  return options;
}

export function backendEnvironment(repo, parent = process.env) {
  const file = path.join(repo, "back/grey/.env");
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

export function backendAddress(env, explicit) {
  const port = env.SERVER_PORT || "8080";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("SERVER_PORT 必须是 1–65535 的端口");
  const context = (env.SERVER_SERVLET_CONTEXT_PATH || "").replace(/\/+$/, "");
  const protocol = env.SERVER_SSL_ENABLED === "true" ? "https" : "http";
  let url;
  try {
    url = new URL(explicit || env.GREYWORK_CONTROL_URL || `${protocol}://127.0.0.1:${port}${context}`);
  } catch {
    throw new Error("Java 后端地址不是合法 URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Java 地址只支持 HTTP(S)，不能含账号密码、查询参数或片段");
  }
  return url.toString().replace(/\/+$/, "");
}

export function desktopEnvironment(parent, address) {
  // Java .env 不传给桌面端；调用者终端中已导出的 Java 命名空间也不继续下发。
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
  let paired = false;
  if (parent.GREYWORK_CONTROL_URL) {
    try {
      paired = backendAddress({}, parent.GREYWORK_CONTROL_URL) === address;
    } catch {
      /* 无法确认凭据对应的地址，不能转发 token。 */
    }
  }
  if (!paired) delete env.GREYWORK_CONTROL_TOKEN;
  return { ...env, GREYWORK_CONTROL_URL: address, GREYWORK_ELECTRON_DIST: "1" };
}

export function javaAddressMatchesConfig(env, address) {
  const target = new URL(address);
  const configured = new URL(backendAddress({ ...env, GREYWORK_CONTROL_URL: undefined }));
  return (
    ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) &&
    target.protocol === configured.protocol &&
    target.port === configured.port &&
    target.pathname.replace(/\/+$/, "") === configured.pathname.replace(/\/+$/, "")
  );
}

/** UP + GreyWork 公共目录均验证通过才复用，不能把占用端口的任意程序当 Java 控制面。 */
export async function probeBackend(address, { signal, fetchImpl = fetch } = {}) {
  const request = { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500), redirect: "error" };
  try {
    const health = await fetchImpl(`${address}/actuator/health`, request);
    const state = await health.json();
    if (state?.status !== "UP") return state?.status === "DOWN" ? "starting" : "foreign";
    const catalog = await fetchImpl(`${address}/api/skills?q=__greywork_startup_probe__`, request);
    return health.ok && catalog.ok && Array.isArray(await catalog.json()) ? "ready" : "foreign";
  } catch {
    signal?.throwIfAborted();
    return "missing";
  }
}

async function portAvailable(address) {
  const url = new URL(address);
  return new Promise((resolve) => {
    const socket = createServer();
    socket.once("error", () => resolve(false));
    socket.listen(Number(url.port || (url.protocol === "https:" ? 443 : 80)), url.hostname.replace(/^\[|\]$/g, ""), () =>
      socket.close(() => resolve(true)),
    );
  });
}

/** 有限等待属于启动程序本身；取消或服务异常退出时立即中止。 */
export async function waitForBackend(address, { signal, timeoutMs = 180_000, intervalMs = 750, probe = probeBackend } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    signal?.throwIfAborted();
    const state = await probe(address, { signal });
    if (state === "ready") return;
    if (state === "foreign") throw new Error("该地址不是健康的 GreyWork Java 控制面；不会关闭占用端口的现有服务");
    await delay(intervalMs, undefined, { signal });
  } while (Date.now() < deadline);
  throw new Error("等待 Java 后端超时，请检查 JDK 25、Docker/MySQL/Redis 和后端日志");
}

export async function stopOwnedChild(child, graceMs = 8000) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("close", done);
    if (isWin) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("error", () => {
        child.kill();
      });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    timer = setTimeout(() => {
      // 进程已退出就不再操作旧 PID，避免延迟清理误杀之后复用 PID 的程序。
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (isWin) child.kill();
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          /* 已退出 */
        }
      }
      done();
    }, graceMs);
  });
}

class StartupExit extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

class OwnedProcesses {
  children = new Set();
  closing = false;
  constructor(controller) {
    this.controller = controller;
  }
  start(name, command, args, cwd, env, service = false) {
    this.controller.signal.throwIfAborted();
    log(`启动 ${name}`);
    const child = spawn(command, args, { cwd, env, stdio: "inherit", detached: !isWin, shell: isWin && command.endsWith(".cmd") });
    this.children.add(child);
    const done = new Promise((resolve) => {
      child.once("error", () => {
        this.controller.abort(new StartupExit(`${name} 无法启动，请检查所需命令和依赖`));
        resolve(1);
      });
      child.once("close", (code) => {
        this.children.delete(child);
        if (service && !this.closing) this.controller.abort(new StartupExit(`${name} 已退出`, code === 0 ? 0 : 1));
        resolve(code ?? 1);
      });
    });
    return done;
  }
  async build(name, args, env) {
    if ((await this.start(name, pnpm, args, root, env)) !== 0) throw new StartupExit(`${name} 失败`);
    this.controller.signal.throwIfAborted();
  }
  async close() {
    this.closing = true;
    await Promise.all([...this.children].map((child) => stopOwnedChild(child)));
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) {
    console.log(`用法：pnpm dev:all [选项]
  --skip-build       复用已有桌面和宿主产物（只在刚构建过时使用）
  --no-backend       仅连接已有 Java 后端，不启动 Maven
  --backend-only     仅启动/检查 Java 后端
  --backend-url URL  指定已有后端地址；默认读取 GREYWORK_CONTROL_URL / SERVER_PORT
  --timeout 秒数     后端就绪等待上限（默认 180 秒，首次下载依赖可调大）
  --help             查看帮助

Java 配置：back/grey/.env（不覆盖；终端环境优先）。前置：Node 22.22+、pnpm、JDK 25、Docker 或外部 MySQL/Redis。
默认构建最新桌面/宿主/Electron，并使用已构建 SPA，不占 Vite 1420 端口。
Ctrl+C 只停止本脚本启动的进程；默认保留 Docker 依赖容器，不生成或修改管理员密码/模型主密钥。`);
    return 0;
  }
  const controller = new AbortController();
  const owned = new OwnedProcesses(controller);
  const interrupt = () => controller.abort(new StartupExit("收到退出信号", 0));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    if (!options.backendOnly && !existsSync(path.join(root, "node_modules")))
      throw new StartupExit("前端依赖尚未安装，请先在仓库根目录运行 pnpm install");
    if (!options.backendOnly && options.skipBuild) {
      for (const entry of ["apps/desktop/dist/index.html", "apps/host-node/dist/index.js", "apps/electron/out/main/index.js"]) {
        if (!existsSync(path.join(root, entry))) throw new StartupExit("缺少构建产物，请移除 --skip-build 后重新启动");
      }
    }
    const backendEnv = backendEnvironment(root);
    const address = backendAddress(backendEnv, options.backendUrl);
    const clientEnv = desktopEnvironment(process.env, address);
    if (process.env.GREYWORK_CONTROL_TOKEN && !clientEnv.GREYWORK_CONTROL_TOKEN)
      log("没有继承未配套或属于其他地址的环境 token，请在客户端账号页登录。");
    log(`Java 地址：${address}；管理页面：${address}/admin`);
    const state = await probeBackend(address, { signal: controller.signal });
    let startedBackend = false;
    if (state === "foreign") throw new StartupExit("地址被其他服务占用；请更换配置，不会自动结束现有服务");
    if (state === "missing") {
      if (options.noBackend || options.backendUrl)
        throw new StartupExit("指定的 Java 后端不可用；请先启动后端，或移除 --no-backend/--backend-url");
      const url = new URL(address);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
        throw new StartupExit("远程 Java 后端不可用，本脚本不会尝试在远程机器启动服务");
      if (!(await portAvailable(address))) throw new StartupExit("Java 端口已占用但健康检查失败；不会关闭现有进程，请检查配置");
      if (backendEnv.GREYWORK_CONTROL_URL && !options.backendUrl) {
        if (!javaAddressMatchesConfig(backendEnv, address))
          throw new StartupExit("GREYWORK_CONTROL_URL 与 Java 端口/上下文配置不一致，请先启动指定后端或修正配置");
      }
      if (!existsSync(path.join(root, "back/grey/.env"))) log("未找到 back/grey/.env，沿用终端配置；首次使用可手动复制 .env.example。");
      if (!backendEnv.GREY_ADMIN_EMAILS) log("管理员邮箱未配置；需要运维台签发入场码时，请配置 GREY_ADMIN_EMAILS。");
      owned.start("Java 后端", isWin ? "mvnw.cmd" : "./mvnw", ["spring-boot:run"], path.join(root, "back/grey"), backendEnv, true);
      startedBackend = true;
    } else log("复用已有后端，不会在退出时停止它；改过 Java 源码时请自行重启旧后端。");
    await waitForBackend(address, { signal: controller.signal, timeoutMs: options.timeoutMs });
    log("Java 后端已就绪");
    if (options.backendOnly && !startedBackend) return 0;
    if (!options.backendOnly) {
      if (!options.skipBuild) {
        await owned.build("桌面界面构建", ["build:desktop"], clientEnv);
        await owned.build("Node 宿主构建", ["--filter", "@greywork/host-node", "build"], clientEnv);
        await owned.build("Electron 主进程构建", ["--filter", "@greywork/electron", "build"], clientEnv);
      }
      for (const entry of ["apps/desktop/dist/index.html", "apps/host-node/dist/index.js", "apps/electron/out/main/index.js"]) {
        if (!existsSync(path.join(root, entry))) throw new StartupExit("缺少构建产物，请移除 --skip-build 后重新启动");
      }
      owned.start("桌面客户端", pnpm, ["--filter", "@greywork/electron", "start"], root, clientEnv, true);
      log("客户端正在启动；请在用户账号页接入 Java。按 Ctrl+C 退出本次环境。");
    }
    await new Promise((resolve) => {
      if (controller.signal.aborted) resolve();
      else controller.signal.addEventListener("abort", resolve, { once: true });
    });
    controller.signal.throwIfAborted();
    return 0;
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    const code = reason instanceof StartupExit ? reason.code : 1;
    if (code !== 0) console.error(`[start-dev] ${reason instanceof Error ? reason.message : "启动失败"}`);
    return code;
  } finally {
    log("仅清理本脚本启动的进程（不按端口杀进程、不删除数据）");
    await owned.close();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error("[start-dev] 启动参数无效，请使用 --help 查看帮助");
      process.exitCode = 1;
    });
}
