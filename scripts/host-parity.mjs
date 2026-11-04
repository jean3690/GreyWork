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
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustBinary = path.join(root, "target", "debug", "greywork-server");
const nodeEntry = path.join(root, "apps", "host-node", "dist", "index.js");
const PASSWORD = "parity-pass";

/** 本地 OpenAI 兼容 mock：两条 LLM 命令都打它，避免对照依赖外网或真实 key。 */
const provider = createHttpServer((request, response) => {
  const url = request.url ?? "";
  if (request.method === "GET" && url.endsWith("/v1/models")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model" }] }));
    return;
  }
  if (request.method === "POST" && url.endsWith("/v1/embeddings")) {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      const input = (JSON.parse(body || "{}").input ?? []).length;
      const embeddings = Array.from({ length: input }, (_value, index) => [index + 1, 2, 3]);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: embeddings.map((embedding) => ({ embedding })) }));
    });
    return;
  }
  if (request.method === "POST" && url.endsWith("/v1/chat/completions")) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
    response.end('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' + "data: [DONE]\n\n");
    return;
  }
  if (request.method === "POST" && url.endsWith("/v1/audio/transcriptions")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ text: "transcribed" }));
    return;
  }
  response.writeHead(404).end();
});

/** 依赖活会话 / 输出含进程级 id 的命令：不参与逐字节对照。 */
const STATEFUL_COMMANDS = new Set([
  "terminal_open",
  "terminal_write",
  "terminal_resize",
  "terminal_close",
  "acp_start",
  "acp_new_session",
  "acp_load_session",
  "acp_send",
  "acp_stop",
  "acp_cancel_session",
  "acp_permission_respond",
  "acp_set_config",
  "acp_set_mode",
  "acp_set_permission_tier",
  "skills_install",
  "skills_uninstall",
  "worktree_provision",
  "worktree_snapshot",
  "worktree_restore",
  // 流式聊天靠事件通道，响应只是一个 requestId，无法逐字节对照。
  "llm_chat_start",
  "llm_chat_stop",
  // 以下命令需要特定参数或外部状态，错误文案由各宿主自行定义（ serde vs 自定义校验），不参与逐字节对照。
  "mcp_probe", "mcp_call",
  "skills_search", "skills_download", "skills_bundled_list", "skills_install_bundled",
  "plugin_net_fetch", "plugin_fs", "plugin_workspace",
  "office_convert_info",
  // 需要外网（GitHub API）：本地对照会变成网络可用性测试。
  "check_update",
  // 以下命令需要特定上下文（版本号不同 / 需要网络 / 需要进程状态 / 需要专用参数），
  // 由各自的端到端用例覆盖而非逐字节对照。
  "sys_info",
  "shell_run",
  "git_stage", "git_unstage", "git_commit", "git_branch_list", "git_log", "git_show",
  "plugin_market_catalog", "plugin_market_preview", "plugin_market_install",
  "plugin_market_list_installed", "plugin_market_uninstall",
  // 依赖磁盘上已有的快照目录，响应随环境变化。
  "worktree_release",
]);

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
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  // 二进制命令回原始字节：比对 sha256 + 长度（逐字节 base64 化只会把差异埋进日志里）。
  if (!contentType.includes("json")) {
    return {
      status: response.status,
      body: { binary: true, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    };
  }
  let body;
  try {
    body = bytes.length === 0 ? null : JSON.parse(bytes.toString("utf8"));
  } catch {
    body = bytes.toString("utf8");
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
  if (command === "rag_search" && Array.isArray(value)) {
    // 平分（同分块向量）时排序取决于遍历顺序；检索契约是「命中的集合 + 分数」，
    // 分数按 6 位小数对齐 f32/f64 的累计精度差。
    return [...value]
      .map((hit) => ({ ...hit, score: Number(hit.score.toFixed(6)) }))
      .sort((left, right) => String(left.path).localeCompare(String(right.path)));
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
// HOME 也要各给一份：会话文件落在 ~/.greyWork，共用一个 HOME 会让两个宿主互写同一个目录。
const homes = dirs.map((dir) => {
  const home = path.join(dir, "home");
  mkdirSync(home, { recursive: true });
  return home;
});
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
  // 二进制读取的夹具：含 NUL 与控制字符，检验 `looks_binary` 与原始字节透传。
  writeFileSync(path.join(workspaceDir, side, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x10]));
  writeFileSync(path.join(workspaceDir, side, "voice.wav"), Buffer.from([0x52, 0x49, 0x46, 0x46]));
  writeFileSync(path.join(workspaceDir, side, "media.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
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
    case "fs_probe_file":
      return { path: path.join(workspaceDir, "hello.txt") };
    case "fs_read_binary":
      return { path: path.join(own, "binary.bin") };
    case "fs_read_media":
      return { path: path.join(own, "media.bin"), maxBytes: 1024 * 1024 };
    case "fs_write_binary":
      return { path: path.join(own, "written.bin"), dataBase64: Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString("base64") };
    case "git_status":
    case "git_changes":
    case "git_current_branch":
      return { root: path.join(own, "repo") };
    case "git_diff":
      return { root: path.join(own, "repo"), path: "a.txt", staged: false };
    case "store_sessions_sync":
      return {
        snapshot: {
          sessions: [
            { id: "s1", title: "one", workspaceId: null, createdAt: 900, updatedAt: 1000, messages: [] },
            { id: "s2", title: "two", workspaceId: null, createdAt: 1900, updatedAt: 2000, messages: [] },
          ],
          activeSessionId: "s2",
        },
        workspaces: [],
        deletedSessionIds: [],
      };
    case "store_sessions_load":
      return { workspaces: [] };
    case "attachments_prune_session":
      return { sessionId: "s1" };
    case "db_agents_sync":
      return {
        providers: [
          { id: "p1", name: "Agent One", kind: "acp", command: "git --acp", enabled: true, env: null },
          { id: "p2", name: "Agent Two", kind: "acp", command: "npx -y agent", enabled: false, env: '{"K":"V"}' },
        ],
      };
    case "db_agents_load":
      return {};
    case "llm_list_models":
      return { baseUrl: providerUrl };
    case "llm_embed":
      return { baseUrl: providerUrl, model: "bge-m3", input: ["a"] };
    case "llm_chat_complete":
      return { baseUrl: providerUrl, model: "m", messages: [{ role: "user", content: "hi" }] };
    case "llm_transcribe":
      return { baseUrl: providerUrl, model: "whisper-1", path: path.join(own, "voice.wav") };
    // 环回地址两侧都必须拒绝：这一条对照的是 SSRF 防线本身（错误文案逐字一致）。
    case "web_fetch":
      return { url: "http://127.0.0.1:9/" };
    case "rag_index_build":
      return { root: workspaceDir, baseUrl: providerUrl, model: "bge-m3" };
    case "rag_search":
      // topK 拉满：mock 的向量按位置生成，平分时 top-K 的截断顺序不构成契约。
      return { query: "hello parity", baseUrl: providerUrl, model: "bge-m3", topK: 50 };
    case "db_automations_sync":
      return {
        tasks: [
          {
            id: "a1",
            name: "每日摘要",
            schedule: "每天 09:00",
            cron: "0 9 * * *",
            target: "",
            intent: "summarize",
            enabled: true,
            lastRun: 0,
            acpProviderId: null,
            onceAt: null,
          },
        ],
      };
    case "db_automations_load":
    case "db_automations_due_list":
    case "db_team_runs_load":
      return {};
    case "db_automations_due_finish":
      return { id: 999, status: "success" };
    case "db_automation_runs_load":
      return { limit: 200 };
    case "db_automation_run_record":
      return {
        run: { taskId: "a1", name: "每日摘要", status: "success", detail: "ok", sessionId: null, mode: "llm", ranAt: 1000 },
      };
    case "db_team_runs_sync":
      return { runs: [{ id: "r1", payload: { plan: [1, 2] } }] };
    case "acp_detect_programs":
      return { programs: ["git", "definitely-not-a-program-xyz"] };
    case "acp_list":
      return {};
    case "db_settings_sync":
      // 两端写各自的库（数据目录不同），但内容必须一致，方便写后复读比对。
      return { settings: { theme: "codex", fontSize: "large", parity: true } };
    default:
      return {};
  }
}
const [rustPort, nodePort] = [await freePort(), await freePort()];
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${provider.address().port}`;

function spawnHost(binary, argv, port, dataDir, name, home) {
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
      HOME: home,
      USERPROFILE: home,
      // 静态目录两边都不设：对照只关心 API。
    },
  });
  const log = [];
  child.stdout.on("data", (chunk) => log.push(String(chunk)));
  child.stderr.on("data", (chunk) => log.push(String(chunk)));
  return { child, name, log };
}

const hosts = [
  spawnHost(rustBinary, [], rustPort, dirs[0], "rust", homes[0]),
  spawnHost(process.execPath, [nodeEntry], nodePort, dirs[1], "node", homes[1]),
];

function shutdown() {
  for (const host of hosts) host.child.kill("SIGTERM");
  provider.close();
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
    [homes[0], "<HOME>"],
    [homes[1], "<HOME>"],
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
  const readBack = candidates.filter((command) =>
    [
      "db_settings_load",
      "store_sessions_load",
      "db_agents_load",
      "db_automations_load",
      "db_automation_runs_load",
      "db_team_runs_load",
    ].includes(command),
  );
  for (const command of readBack) {
    // 复读也要带该命令的参数（`store_sessions_load` 的 workspaces 是必填，不会走默认值）。
    const [rust, node] = await Promise.all([
      call(rustPort, rustToken, command, argsFor(command, "rust")),
      call(nodePort, nodeToken, command, argsFor(command, "node")),
    ]);
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

  // 二进制写入：按字节比对（utf8 读法会把内容变成替换字符，掩盖真实差异）。
  const expectedBin = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  for (const side of ["rust", "node"]) {
    const target = path.join(workspaceDir, side, "written.bin");
    const actual = existsSync(target) ? readFileSync(target) : null;
    if (!actual || !actual.equals(expectedBin)) {
      failures += 1;
      console.log(`  ✗ 二进制写入不一致：${side}/written.bin = ${actual ? actual.toString("hex") : "(缺失)"}`);
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
  for (const host of hosts) {
    if (host.log.length) console.error(`--- ${host.name} 输出 ---\n${host.log.join("")}`);
  }
  failures += 1;
} finally {
  shutdown();
}

process.exit(failures === 0 ? 0 : 1);
