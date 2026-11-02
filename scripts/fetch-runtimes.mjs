#!/usr/bin/env node
/**
 * 取随安装包分发的运行时（内置 git / opencode / rg / fd / jq）。
 *
 * 用法：
 *   node scripts/fetch-runtimes.mjs               # 当前平台
 *   node scripts/fetch-runtimes.mjs --target win32-x64
 *   node scripts/fetch-runtimes.mjs --force       # 忽略已有产物，重新下载
 *   node scripts/fetch-runtimes.mjs --list        # 只打印清单
 *
 * 产物落到 `apps/electron/runtime/`（electron-builder 整目录带进 `resources/runtime`）：
 *
 *   bin/<tool>[.exe]   单文件工具；宿主把 `bin` 前置进 PATH（探测与 spawn 同一条路径）；
 *   git/               Windows MinGit 整棵树，`git.exe` 在 `git/cmd`（宿主也前置它；
 *                      MinGit 的 DLL 在 `mingw64/bin`，由 git.exe 按自身路径加载，不进 PATH）；
 *   runtime.json       本次取到的目标与版本，用于幂等判断与打包日志。
 *
 * 为什么按 sha256 校验：这些二进制要随安装包发给用户，源是 GitHub Release。固定版本 +
 * 摘要比对是唯一能保证「用户跑的就是我验过的那一份」的手段（清单里的摘要取自 Release API
 * 的 digest 字段，改版本必须同步改摘要）。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const MANIFEST = path.join(here, "runtime-versions.json");
/** 产物目录：**不分平台**，因为一次打包只服务一个目标。换目标时整目录重建。 */
const OUT_DIR = path.join(root, "apps", "electron", "runtime");
/** 下载缓存：按 sha256 命名，换版本不会命中旧文件，也不会重复下载同一份。 */
const CACHE_DIR = path.join(root, "node_modules", ".cache", "greywork-runtime");
/** 解包临时目录（产物目录的同级，避免被 electron-builder 扫进去）。 */
const TMP_DIR = path.join(root, "apps", "electron", ".runtime-tmp");
const STATE_FILE = path.join(OUT_DIR, "runtime.json");
const MANIFEST_VERSION = "1";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const target = option("target") ?? `${process.platform}-${process.arch}`;
const force = flag("force");

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const entry = manifest.targets[target];
if (!entry) {
  console.error(`✗ 未知目标 ${target}；可用：${Object.keys(manifest.targets).join(", ")}`);
  process.exit(1);
}

if (flag("list")) {
  for (const [name, spec] of Object.entries(manifest.targets)) {
    console.log(name, spec.files.map((file) => `${file.id}@${file.version}`).join(" "));
  }
  process.exit(0);
}

const readState = () => {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return parsed?.manifestVersion === MANIFEST_VERSION ? parsed : null;
  } catch {
    return null;
  }
};

const state = readState();
const files = entry.files;
const upToDate = !force && state?.target === target && files.every((file) => existsSync(path.join(OUT_DIR, file.dest)));

if (upToDate) {
  console.log(`运行时已是最新（${target}）：${files.map((f) => `${f.id}@${f.version}`).join(" ")}`);
  process.exit(0);
}

// 换目标 / 强制重取：整个产物目录重建。混入上个平台的二进制会让打包结果说不清。
if (state?.target !== target || force) rmSync(OUT_DIR, { recursive: true, force: true });
rmSync(TMP_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(CACHE_DIR, { recursive: true });

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** 下载到缓存（命中即复用），返回本地路径；摘要不符直接失败 —— 绝不落进产物目录。 */
async function download(file) {
  const cached = path.join(CACHE_DIR, `${file.sha256}-${path.basename(new URL(file.url).pathname)}`);
  if (existsSync(cached) && sha256(cached) === file.sha256) {
    console.log(`  · ${file.id} ${file.version} 命中缓存`);
    return cached;
  }
  const started = Date.now();
  const response = await fetch(file.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`下载失败 ${response.status} ${response.statusText}：${file.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== file.sha256) {
    throw new Error(`摘要不符（${file.id}）\n  期望 ${file.sha256}\n  实际 ${actual}`);
  }
  writeFileSync(cached, bytes);
  const mb = (bytes.length / 1048576).toFixed(1);
  console.log(`  · ${file.id} ${file.version} 下载完成 ${mb}MB / ${Date.now() - started}ms`);
  return cached;
}

/**
 * 解包到临时目录。`tar.gz` 走 tar；`zip` 在 Windows 上走自带的 bsdtar（`tar.exe` 认 zip），
 * 其它平台走 `unzip` —— GNU tar 不认 zip，这是唯一需要分平台的地方。
 */
function extract(file, archive, into, member) {
  if (file.archive === "tar.gz") {
    execFileSync("tar", ["-xzf", archive, "-C", into, ...(member ? [member] : [])], { stdio: "inherit" });
    return;
  }
  if (process.platform === "win32") {
    execFileSync("tar", ["-xf", archive, "-C", into, ...(member ? [member] : [])], { stdio: "inherit" });
    return;
  }
  try {
    execFileSync("unzip", ["-q", "-o", archive, ...(member ? [member] : []), "-d", into], { stdio: "inherit" });
  } catch (error) {
    throw new Error(`解包 zip 需要 unzip（当前平台没有或执行失败）：${error.message}`, { cause: error });
  }
}

for (const file of files) {
  const archive = await download(file);
  const dest = path.join(OUT_DIR, file.dest);
  mkdirSync(path.dirname(dest), { recursive: true });

  if (file.tree) {
    // 整棵树（MinGit）：直接铺进目标目录。
    mkdirSync(dest, { recursive: true });
    extract(file, archive, dest);
  } else if (file.archive === "none") {
    copyFileSync(archive, dest);
  } else {
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
    extract(file, archive, TMP_DIR, file.member);
    const unpacked = path.join(TMP_DIR, ...file.member.split("/"));
    if (!existsSync(unpacked)) throw new Error(`压缩包里没有 ${file.member}（${file.id}）`);
    renameSync(unpacked, dest);
    rmSync(TMP_DIR, { recursive: true, force: true });
  }

  // unzip / tar 会丢执行位：unix 上必须显式补回，否则 spawn 直接 EACCES。
  if (process.platform !== "win32" && !file.tree) chmodSync(dest, 0o755);
}

writeFileSync(
  STATE_FILE,
  `${JSON.stringify(
    {
      manifestVersion: MANIFEST_VERSION,
      target,
      tools: files.map((file) => ({ id: file.id, version: file.version })),
    },
    null,
    2,
  )}\n`,
);

const total = files.reduce((sum, file) => {
  const at = path.join(OUT_DIR, file.dest);
  if (!existsSync(at)) return sum;
  const stat = statSync(at);
  if (!stat.isFile()) return sum;
  return sum + stat.size;
}, 0);

console.log(`✓ 运行时就绪（${target}）：${files.map((f) => `${f.id}@${f.version}`).join(" ")} → ${path.relative(root, OUT_DIR)}`);
console.log(`  可执行文件合计 ${(total / 1048576).toFixed(1)}MB（git 为整棵树，未计入）`);
