#!/usr/bin/env node
/**
 * 开发辅助工具链的磁盘回收（默认只报数，不删）。
 *
 * 为什么需要它：这个仓库的 dev 构建产物会长到几十 GB（2026-09-29 实测 target/debug
 * 66GB，其中 incremental 33GB / 512 个目录），而 cargo / docker / pnpm **都不会自动
 * 回收自己的陈旧缓存**。没有这道脚本，磁盘就是靠人手发现的。
 *
 * 用法：
 *   node scripts/disks-reclaim.mjs              # 只报数（dry-run，默认）
 *   node scripts/disks-reclaim.mjs --apply      # 真删
 *   node scripts/disks-reclaim.mjs cargo --apply # 只跑某一项
 *
 *   --days <n>    cargo 增量目录的保留天数，默认 1（0 = 全删，最激进）
 *   --volumes     连 docker 悬空卷一起清（--apply 时才生效，见下方警告）
 *
 * ── 各项的「安全边界」在哪 ───────────────────────────────────────────────
 *
 * cargo  增量编译目录按 mtime 剪枝。删掉它们**不会**让构建出错，只会让受影响的那个
 *        crate 下次全量重编。所以这里只按时间剪、不碰 deps/ 与 build/（后者被别的构建
 *        阶段硬引用，删了会连带触发大量重编，收益却小得多）。
 *
 *        **这里只装着 workspace 自己的产物，所以比看上去便宜得多。** cargo 只对
 *        workspace 成员与 path 依赖开增量编译，registry 依赖一律不开（见 cargo profile
 *        文档）。2026-09-29 实测 515 个目录里只有 greywork_host(68) / greywork_server(60)
 *        / greywork_lib(59) / greywork(59) 等本仓 crate 与 26 个 build_script_build，
 *        一个 serde / tokio 都没有。所以「全删」的代价只是这几个 crate 重编一次，
 *        deps/ 里那 29.3G 完全不受影响 —— `--days 0` 并不暴力。
 *
 *        默认保留期因此压到 1 天。原先默认 7 天是按「稳态一周的量」估的，但实测这个
 *        目录的体积几乎全来自少数几天的**爆发**（一次全量 clippy --all-targets + test
 *        + build 就能造出几百个会话目录）：mtime 分布是 09-24 一天 284 个、09-28 六个
 *        8 个、09-29 一百零七个，其余二十多天加起来不到 700M。7 天窗口因此只能剪掉
 *        54 个 / 682M，33.6G 里的大头一个没动。1 天则能收掉真正占量的那几天。
 *
 *        另外，.husky/pre-push 已经 export CARGO_INCREMENTAL=0，不再往这里堆新目录；
 *        这道脚本负责的是**存量**。
 *
 * docker 默认只清**悬空**镜像与构建缓存 —— 两者都是可再生的中间产物。**卷不进默认**：
 *        匿名卷里可能有别的项目的数据，docker 自己判断不了。必须显式 --volumes。
 *
 * pnpm   `store prune` 删的是全局 store 里没被任何项目引用的包，语义安全。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);

/** dry-run 是默认值：要真删必须显式 --apply，避免手滑。 */
const APPLY = argv.includes("--apply");
const WANT_VOLUMES = argv.includes("--volumes");
const daysIdx = argv.indexOf("--days");
const DAYS = daysIdx !== -1 ? Number(argv[daysIdx + 1]) : 1;
const TARGETS = argv.filter((a) => !a.startsWith("--") && a !== String(DAYS));

const fmt = (bytes) => {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)}G` : `${(bytes / 1024 ** 2).toFixed(0)}M`;
};

const log = (msg) => console.log(msg);

/** 跑一条外部命令；返回 {ok, out}，不抛 —— 命令不存在也要继续报下一项。 */
function run(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }) };
  } catch (error) {
    return { ok: false, out: (error.stdout ?? "") + (error.stderr ?? "") || String(error.message) };
  }
}

/**
 * 批量求若干路径的递归体积，返回 Map<路径, 字节>。
 *
 * **必须走 du 而不是自己 readdir + stat**：本仓库 target/debug 下有五万多个文件
 * （incremental 512 个会话目录 + deps 5019 个产物），纯 JS 逐个 stat 一遍要几十秒，
 * 足够让这条命令在 CI 里撞上超时。du 一次 fork 走完，且能一次吃下多个路径 ——
 * 剪枝前要逐目录求和，批量调用才不会出现 N 次 fork。
 *
 * 路径不存在时 du 会非零退出，这里退回「缺失即 0」。
 */
function duBytes(paths) {
  const sizes = new Map();
  if (!paths.length) return sizes;
  const res = run("du", ["-sb", ...paths]);
  for (const line of res.out.split("\n")) {
    const match = line.match(/^(\d+)\t(.*)$/);
    if (match) sizes.set(match[2], Number(match[1]));
  }
  for (const p of paths) if (!sizes.has(p)) sizes.set(p, 0);
  return sizes;
}

/** 单个路径的递归体积（字节）。 */
function dirSize(dir) {
  return duBytes([dir]).get(dir) ?? 0;
}

function wanted(name) {
  return TARGETS.length === 0 || TARGETS.includes(name);
}

// ── cargo：剪掉陈旧的增量编译目录 ──────────────────────────────────────
function reclaimCargo() {
  const incremental = path.join(ROOT, "target/debug/incremental");
  let dirs;
  try {
    dirs = readdirSync(incremental, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(incremental, e.name));
  } catch {
    log("cargo: 无 target/debug/incremental，跳过");
    return;
  }

  const cutoff = DAYS === 0 ? Infinity : Date.now() - DAYS * 864e5;
  const stale = dirs.filter((d) => statSync(d).mtimeMs < cutoff);
  const bytes = [...duBytes(stale).values()].reduce((a, b) => a + b, 0);

  log(`\ncargo — 增量编译目录 ${dirs.length} 个，超 ${DAYS} 天的 ${stale.length} 个 = ${fmt(bytes)}`);
  if (!stale.length) {
    log("  无可剪枝项");
    return;
  }
  if (!APPLY) {
    log("  (dry-run，加 --apply 执行)");
    return;
  }
  for (const dir of stale) rmSync(dir, { recursive: true, force: true });
  log(`  已删除 ${stale.length} 个目录，回收 ${fmt(bytes)}（下次构建会重编这些 crate）`);
}

// ── docker：悬空镜像 + 构建缓存（卷需显式 --volumes）────────────────────
function reclaimDocker() {
  const df = run("docker", ["system", "df"]);
  if (!df.ok) {
    log("\ndocker — 不可用（未安装 / 无守护进程 / 无权访问），跳过");
    return;
  }
  log("\ndocker — 当前占用");
  for (const line of df.out.split("\n").slice(0, 6)) if (line.trim()) log(`  ${line}`);

  const steps = [
    ["image", ["image", "prune", "-f"]],
    ["builder", ["builder", "prune", "-f"]],
  ];
  if (WANT_VOLUMES) {
    log("\n  ⚠ --volumes：悬空卷里可能有其它项目的数据，docker 判断不了");
    steps.push(["volume", ["volume", "prune", "-f"]]);
  } else {
    log("\n  (卷不在默认范围；要清加 --volumes)");
  }

  for (const [label, args] of steps) {
    if (!APPLY) {
      log(`  (dry-run) docker ${args.join(" ")}`);
      continue;
    }
    const res = run("docker", args);
    const reclaimed = res.out.match(/Reclaimed:\s*(\S+)/)?.[1];
    log(`  docker ${label} prune: ${res.ok && reclaimed ? `回收 ${reclaimed}` : res.out.trim().split("\n")[0] || "无变化"}`);
  }
}

// ── pnpm：全局 store 里无人引用的包 ────────────────────────────────────
function reclaimPnpm() {
  const locate = run("pnpm", ["store", "path"]);
  if (!locate.ok) {
    log("\npnpm — 不可用，跳过");
    return;
  }
  const store = locate.out.trim();
  log(`\npnpm — store ${store} = ${fmt(dirSize(store))}`);
  if (!APPLY) {
    log("  (dry-run，加 --apply 执行 `pnpm store prune`)");
    return;
  }
  const res = run("pnpm", ["store", "prune"]);
  log(res.ok ? `  prune 后 ${fmt(dirSize(store))}` : `  失败：${res.out.trim()}`);
}

// ── 报告 ────────────────────────────────────────────────────────────────
function report() {
  const rels = ["target/debug/incremental", "target/debug/deps", "target/debug/build", "target/release", "node_modules", "coverage"];
  const sizes = duBytes(rels.map((rel) => path.join(ROOT, rel)));
  log("仓库内产物（dev 构建是大头）");
  for (const rel of rels) {
    const size = sizes.get(path.join(ROOT, rel)) ?? 0;
    if (size) log(`  ${fmt(size).padStart(7)}  ${rel}`);
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────
log(APPLY ? "模式：APPLY（会真的删）" : "模式：dry-run（只报数，不删）");
if (wanted("report")) report();
if (wanted("cargo")) reclaimCargo();
if (wanted("docker")) reclaimDocker();
if (wanted("pnpm")) reclaimPnpm();
if (!APPLY) log("\n（以上未删任何东西；加 --apply 执行）");
