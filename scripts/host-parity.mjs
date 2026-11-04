#!/usr/bin/env node
/**
 * 双轨对照：同一份环境变量分别起 Rust 与 Node 宿主，逐命令比对状态码与响应体。
 *
 * 为什么需要它：迁移期有两套实现，行为漂移是最大风险。任何一条命令在 Node 侧标
 * `available: true` 之前，都必须先在这里与 Rust 对上；CI 里跑它就能阻止「看着像能用」。
 *
 * 用法：
 *   node scripts/host-parity.mjs                 # 跑所有 Node 已迁移且 Rust 可用的命令
 *   node scripts/host-parity.mjs --commands=terminal_shells,store_default_root
 *   node scripts/host-parity.mjs --keep          # 不删临时数据目录（排查用）
 *
 * 前提：`cargo build -p greywork-server`（或 `pnpm electron:dev:all` 跑过一次）与
 * `pnpm --filter @greywork/host-node build`，Node 宿主读 dist/。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustBinary = path.join(root, "target", "debug", "greywork-server");
const nodeEntry = path.join(root, "apps", "host-node", "dist", "index.js");
const PASSWORD = "parity-pass";

const args = new Set(process.argv.slice(2));
const keep = args.has("--keep");
const explicit = [...args]
  .find((item) => item.startsWith("--commands="))
  ?.slice("--commands=".length)
  .split(",")
  .filter(Boolean);

function fail(message) {
  console.error(`[parity] ${message}`);
  process.exit(1);
}

if (!existsSync(rustBinary)) {
  fail(`缺少 Rust 二进制 ${path.relative(root, rustBinary)}：先 cargo build -p greywork-server`);
}
if (!existsSync(nodeEntry)) {
  fail(`缺少 Node 宿主构建产物 ${path.relative(root, nodeEntry)}：先 pnpm --filter @greywork/host-node build`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitHealth(port, child, label) {
  const deadline = Date.now() + 20_000;
  const url = `http://127.0.0.1:${port}/api/health`;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} 启动后立即退出（code=${child.exitCode}）`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} 健康检查超时：${url}`);
}

async function login(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`登录失败：HTTP ${response.status}`);
  const body = await response.json();
  return body.token;
}

async function call(port, token, command, commandArgs) {
  const response = await fetch(`http://127.0.0.1:${port}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ command, args: commandArgs }),
  });
  const text = await response.text();
  let body;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/** 把随机端口与临时目录抹平，避免「只是路径不同」被误报成行为差异。 */
function normalize(value, replace) {
  if (typeof value === "string") {
    return replace.reduce((acc, [from, to]) => acc.split(from).join(to), value);
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, replace));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, replace)]));
  }
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const label = process.env.HOME ? path.basename(process.env.HOME) : "user";
const dirs = [mkdtempSync(path.join(tmpdir(), "gw-parity-rust-")), mkdtempSync(path.join(tmpdir(), "gw-parity-node-"))];
const [rustPort, nodePort] = [await freePort(), await freePort()];

function spawnHost(binary, argv, port, dataDir, name) {
  const child = spawn(binary, argv, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GREYWORK_BIND: `127.0.0.1:${port}`,
      GREYWORK_DATA_DIR: dataDir,
      GREYWORK_PASSWORD: PASSWORD,
      // 以「本机桌面端」口径对照：否则 terminal_* / shell_run 这类可信宿主命令两边都不可用，
      // 反而把最值得对照的一批排除掉了。
      GREYWORK_TRUSTED_HOST: "1",
      // 静态目录两边都不设：对照只关心 API。
    },
  });
  const log = [];
  child.stdout.on("data", (chunk) => log.push(String(chunk)));
  child.stderr.on("data", (chunk) => log.push(String(chunk)));
  return { child, name, log };
}

const hosts = [spawnHost(rustBinary, [], rustPort, dirs[0], "rust"), spawnHost(process.execPath, [nodeEntry], nodePort, dirs[1], "node")];

function shutdown() {
  for (const host of hosts) host.child.kill("SIGTERM");
  if (!keep) for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(130);
});

let failures = 0;
try {
  await Promise.all([waitHealth(rustPort, hosts[0].child, "rust"), waitHealth(nodePort, hosts[1].child, "node")]);
  const [rustToken, nodeToken] = await Promise.all([login(rustPort), login(nodePort)]);

  const replace = [
    [dirs[0], "<DATA>"],
    [dirs[1], "<DATA>"],
    [String(rustPort), "<PORT>"],
    [String(nodePort), "<PORT>"],
  ];

  // 对照集：Node 标 available 的命令（= 已迁移），再与 Rust 的可用性取交集。
  let candidates = explicit;
  if (!candidates) {
    const [nodeList, rustList] = await Promise.all([
      fetch(`http://127.0.0.1:${nodePort}/api/commands`, {
        headers: { authorization: `Bearer ${nodeToken}` },
      }).then((response) => response.json()),
      fetch(`http://127.0.0.1:${rustPort}/api/commands`, {
        headers: { authorization: `Bearer ${rustToken}` },
      }).then((response) => response.json()),
    ]);
    const rustAvailable = new Map(rustList.map((item) => [item.name, item.available]));
    candidates = nodeList.filter((item) => item.available && rustAvailable.get(item.name) === true).map((item) => item.name);
  }

  if (candidates.length === 0) {
    console.log("[parity] 没有可对照的命令（Node 已迁移集合为空？）");
    process.exit(0);
  }

  console.log(`[parity] 对照 ${candidates.length} 条命令（执行用户：${label}）`);
  for (const command of candidates) {
    const commandArgs = {};
    const [rust, node] = await Promise.all([
      call(rustPort, rustToken, command, commandArgs),
      call(nodePort, nodeToken, command, commandArgs),
    ]);
    const left = normalize(rust, replace);
    const right = normalize(node, replace);
    const same = left.status === right.status && stableStringify(left.body) === stableStringify(right.body);
    if (same) {
      console.log(`  ✓ ${command}（HTTP ${left.status}）`);
      continue;
    }
    failures += 1;
    console.log(`  ✗ ${command}`);
    console.log(`    rust: ${left.status} ${stableStringify(left.body)}`);
    console.log(`    node: ${right.status} ${stableStringify(right.body)}`);
  }

  if (failures > 0) {
    console.log(`[parity] ${failures} 条命令不一致`);
    for (const host of hosts) {
      if (host.log.length) console.log(`--- ${host.name} 输出 ---\n${host.log.join("")}`);
    }
  } else {
    console.log("[parity] 全部一致");
  }
} catch (error) {
  console.error("[parity] 执行失败：", error);
  failures += 1;
} finally {
  shutdown();
}

process.exit(failures === 0 ? 0 : 1);
