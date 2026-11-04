/**
 * Node 宿主入口：默认起服务；`hash-password` 与 Rust 的 `greywork-server hash-password`
 * 同用途（Electron 首启靠它把明文转成 PHC 串，只走 stdout）。
 *
 * 迁移期定位：P0 只跑通「HTTP + 会话 + 命令分发 + 静态托管」，命令实现按领域逐步搬。
 * 与 Rust 侧的差异与进度见 docs/node-backend-migration.md。
 */
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

import { argon2id } from "hash-wasm";

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { LoginThrottle, SessionStore, passwordChecker } from "./auth.js";
import { Db } from "./db.js";
import { loadConfig } from "./config.js";
import { createHostServer } from "./server.js";
import { resolveStaticRoot } from "./static-site.js";
import { WorkspaceAccess } from "./workspace-access.js";
import { EventBus } from "./events.js";
import { TerminalHost } from "./terminal.js";

/** 与 Rust `config::hash_password` 的 argon2 参数对齐（argon2 crate 默认值）。 */
async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(16),
    parallelism: 1,
    iterations: 2,
    memorySize: 19456,
    hashLength: 32,
    outputType: "encoded",
  });
}

function readPasswordTwice(): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const first: string[] = [];
    let stage = 0;
    rl.on("line", (line) => {
      if (stage === 0) {
        first.push(line);
        stage = 1;
        rl.setPrompt("再次输入密码: ");
        rl.prompt();
        return;
      }
      const password = first[0] ?? "";
      rl.close();
      if (line !== password) {
        console.error("两次输入的密码不一致");
        resolve(null);
        return;
      }
      resolve(password);
    });
    rl.setPrompt("输入密码: ");
    rl.prompt();
  });
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "hash-password") {
    const password = await readPasswordTwice();
    if (password === null) process.exit(1);
    process.stdout.write(`${await hashPassword(password)}\n`);
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    console.log("用法: host-node [hash-password|help]");
    return;
  }

  const config = loadConfig();
  const staticRoot = resolveStaticRoot(config.staticDir);
  const sessions = new SessionStore(passwordChecker(config), config.sessionTtlSecs);
  const throttle = new LoginThrottle();
  // 授权面：默认根 ~/.greyWork + 配置预置根；账本放数据目录（与 Rust 同名）。
  const defaultRoot = path.join(homedir(), ".greyWork");
  mkdirSync(defaultRoot, { recursive: true });
  const access = new WorkspaceAccess(defaultRoot, path.join(config.dataDir, "workspace-path-access.json"));
  for (const root of config.workspaceRoots) {
    console.log(`[host-node] 预置授权根: ${access.authorizeSelectedPath(root)}`);
  }
  const db = new Db(path.join(config.dataDir, "greywork.db"));
  const bus = new EventBus();
  const terminal = new TerminalHost(bus, access);
  const { server, close } = createHostServer({
    config,
    sessions,
    throttle,
    staticRoot,
    access,
    db,
    bus,
    terminal,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
  console.log(`[host-node] 监听 http://${config.host}:${config.port}（version=${config.version}）`);
  if (!config.passwordHash && !config.password) {
    console.warn("[host-node] 未配置 GREYWORK_PASSWORD / GREYWORK_PASSWORD_HASH：登录必定失败（这是刻意的 fail-closed）");
  }

  let stopping = false;
  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[host-node] 关闭（${reason}）`);
    terminal.disposeAll();
    await close();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  if (config.exitOnStdinEof) {
    // Electron 的「父死子死」：主进程被强杀时 stdin 管道关闭，这里读到 EOF 自行退出。
    process.stdin.on("end", () => void shutdown("stdin EOF"));
    process.stdin.resume();
  }
}

await main();
