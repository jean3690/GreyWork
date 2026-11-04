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
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustBinary = path.join(root, "target", "debug", "greywork-server");
const nodeEntry = path.join(root, "apps", "host-node", "dist", "index.js");
const PASSWORD = "parity-pass";

/** 依赖活会话 / 输出含进程级 id 的命令：不参与逐字节对照。 */
const STATEFUL_COMMANDS = new Set(["terminal_open", "terminal_write", "terminal_resize", "terminal_close"]);

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

/**
 * 少数命令的返回值是**集合**而非有序序列：`fs_list_dir` 走的是文件系统枚举顺序，
 * 同一目录在 Rust / Node 下也可能不同（前端 `fileTree` 用 `sortEntries` 统一排，顺序不影响行为）。
 * 这类命令在这里按稳定键排序后再比，既不放过真正的差异，也不被枚举顺序误报。
 */
function normalizeForCommand(command, value) {
  if (command === "fs_list_dir" && Array.isArray(value)) {
    return [...value].sort((left, right) => String(left.path).localeCompare(String(right.path)));
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
// 两边共用的工作区夹具：同一批文件、同一个绝对路径（只靠 GREYWORK_WORKSPACE_ROOTS 授权）。
const workspaceDir = mkdtempSync(path.join(tmpdir(), "gw-parity-ws-"));
writeFileSync(path.join(workspaceDir, "hello.txt"), "hello parity\n");
mkdirSync(path.join(workspaceDir, "sub"), { recursive: true });
writeFileSync(path.join(workspaceDir, "sub", "nested.txt"), "nested\n");
// 写面各自一个子目录：两边不能互相踩（同一个路径写两次，第二次的 EEXIST 会变成假差异）。
for (const side of ["rust", "node"]) {
  mkdirSync(path.join(workspaceDir, side, "created"), { recursive: true });
  // 删除 / 改名 / 复制的夹具：两边各一份，互不影响。
  writeFileSync(path.join(workspaceDir, side, "victim.txt"), "bye");
  writeFileSync(path.join(workspaceDir, side, "before.txt"), "move me");
  writeFileSync(path.join(workspaceDir, side, "copy-src.txt"), "copy me");
  // git 只读命令需要真实仓库：固定分支名与提交时间，避免默认配置把差异带进来。
  const repo = path.join(workspaceDir, side, "repo");
  mkdirSync(repo, { recursive: true });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "parity",
    GIT_AUTHOR_EMAIL: "parity@example.com",
    GIT_COMMITTER_NAME: "parity",
    GIT_COMMITTER_EMAIL: "parity@example.com",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  const git = (...args) => execFileSync("git", args, { cwd: repo, env: gitEnv, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
  writeFileSync(path.join(repo, "untracked.txt"), "new\n");
}

/**
 * 逐命令的入参。需要路径的命令在这里给夹具路径 —— 两边拿到的是同一份绝对路径，
 * 于是差异只可能来自实现，而不是环境。
 */
function argsFor(command, side) {
  const own = path.join(workspaceDir, side);
  switch (command) {
    case "fs_list_dir":
      return { path: workspaceDir };
    case "fs_read_text_file":
      return { path: path.join(workspaceDir, "hello.txt") };
    case "fs_write_text_file":
      return { path: path.join(own, "written.txt"), content: "parity write\n" };
    case "fs_ensure_dir":
      return { path: path.join(own, "made", "deep") };
    case "fs_create_dir":
      return { path: path.join(own, "fresh") };
    case "fs_create_file":
      return { path: path.join(own, "created", "new.txt") };
    case "fs_delete_path":
      return { path: path.join(own, "victim.txt") };
    case "fs_rename_path":
      return { from: path.join(own, "before.txt"), to: path.join(own, "after.txt") };
    case "fs_copy_path":
      return { from: path.join(own, "copy-src.txt"), to: path.join(own, "copy-dst.txt") };
    case "git_status":
    case "git_changes":
    case "git_current_branch":
      return { root: path.join(own, "repo") };
    case "git_diff":
      return { root: path.join(own, "repo"), path: "a.txt", staged: false };
    case "db_settings_sync":
      // 两端写各自的库（数据目录不同），但内容必须一致，方便写后复读比对。
      return { settings: { theme: "codex", fontSize: "large", parity: true } };
    default:
      return {};
  }
}
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
      GREYWORK_WORKSPACE_ROOTS: workspaceDir,
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
  if (keep) return;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
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
    [path.join(workspaceDir, "rust"), "<WS>/<HOST>"],
    [path.join(workspaceDir, "node"), "<WS>/<HOST>"],
    [workspaceDir, "<WS>"],
    [dirs[0], "<DATA>"],
    [dirs[1], "<DATA>"],
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
    candidates = nodeList
      .filter((item) => item.available && rustAvailable.get(item.name) === true)
      .map((item) => item.name)
      // 会话型命令不参与自动对照：terminal_open 的 sessionId 含宿主 pid（必然不同），
      // 后续 write/resize/close 又依赖一条活的 PTY。它们由 host-node 的端到端用例覆盖
      // （开 shell → 写命令 → 收 base64 输出 → 关闭），这里只保留无状态的 terminal_list。
      .filter((name) => !STATEFUL_COMMANDS.has(name));
  }

  if (candidates.length === 0) {
    console.log("[parity] 没有可对照的命令（Node 已迁移集合为空？）");
    process.exit(0);
  }

  console.log(`[parity] 对照 ${candidates.length} 条命令（执行用户：${label}）`);
  for (const command of candidates) {
    const [rust, node] = await Promise.all([
      call(rustPort, rustToken, command, argsFor(command, "rust")),
      call(nodePort, nodeToken, command, argsFor(command, "node")),
    ]);
    // 排序只作用于 body（status 是标量），避免把包装对象也交给集合归一化。
    const left = normalize(normalizeForCommand(command, rust.body), replace);
    const right = normalize(normalizeForCommand(command, node.body), replace);
    const same = rust.status === node.status && stableStringify(left) === stableStringify(right);
    if (same) {
      console.log(`  ✓ ${command}（HTTP ${rust.status}）`);
      continue;
    }
    failures += 1;
    console.log(`  ✗ ${command}`);
    console.log(`    rust: ${rust.status} ${stableStringify(left)}`);
    console.log(`    node: ${node.status} ${stableStringify(right)}`);
  }

  // 读类命令在写完之后再复读一次：db_settings_sync 的响应只是 null，真值要回读才知道。
  const readBack = candidates.filter((command) => command === "db_settings_load");
  for (const command of readBack) {
    const [rust, node] = await Promise.all([call(rustPort, rustToken, command, {}), call(nodePort, nodeToken, command, {})]);
    const left = normalize(rust.body, replace);
    const right = normalize(node.body, replace);
    if (rust.status === node.status && stableStringify(left) === stableStringify(right)) {
      console.log(`  ✓ ${command}（写后复读，HTTP ${rust.status}）`);
    } else {
      failures += 1;
      console.log(`  ✗ ${command}（写后复读）`);
      console.log(`    rust: ${rust.status} ${stableStringify(left)}`);
      console.log(`    node: ${node.status} ${stableStringify(right)}`);
    }
  }

  // 删除 / 改名 / 复制同样要验副作用：响应都是 null，差别只体现在文件系统上。
  const sideEffects = [
    { name: "victim.txt", exists: false, content: null },
    { name: "after.txt", exists: true, content: "move me" },
    { name: "copy-dst.txt", exists: true, content: "copy me" },
  ];
  for (const effect of sideEffects) {
    for (const side of ["rust", "node"]) {
      const target = path.join(workspaceDir, side, effect.name);
      const present = existsSync(target);
      const content = present && effect.content !== null ? readFileSync(target, "utf8") : null;
      if (present !== effect.exists || (effect.content !== null && content !== effect.content)) {
        failures += 1;
        console.log(`  ✗ 副作用不一致：${side}/${effect.name} exists=${present} content=${JSON.stringify(content)}`);
      }
    }
  }

  // 写面光比响应不够（两边都回 null）；落盘结果也必须一致。
  try {
    const [rustWritten, nodeWritten] = ["rust", "node"].map((side) => readFileSync(path.join(workspaceDir, side, "written.txt"), "utf8"));
    if (rustWritten !== nodeWritten) {
      failures += 1;
      console.log(`  ✗ 写面副作用不一致：rust=${JSON.stringify(rustWritten)} node=${JSON.stringify(nodeWritten)}`);
    }
  } catch (error) {
    failures += 1;
    console.log(`  ✗ 写面产物缺失：${error.message}`);
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
