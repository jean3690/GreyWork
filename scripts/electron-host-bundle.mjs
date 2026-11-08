#!/usr/bin/env node
/**
 * 把 `apps/host-node` 摊成「可随安装包分发的独立目录」`apps/electron/build/host`。
 *
 * 为什么要摊：Electron 壳的 sidecar 直接用 Electron 自带的 Node 跑宿主入口
 * （`process.execPath` + `ELECTRON_RUN_AS_NODE`），所以安装包里必须有 **dist + 生产依赖**
 * （ws / node-pty 原生模块 / @e965/xlsx / hash-wasm / @wechatbot/wechatbot）。工作区里的
 * `node_modules` 是 pnpm 的符号链接结构，整目录拷进安装包不能跑。
 *
 * 产物落点与 electron-builder.yml 的 `extraResources: build/host → host` 对应，
 * 运行时由 `paths.ts` 解析成 `<resources>/host/dist/index.js`。
 *
 * 原生模块（node-pty）**按构建机平台编译**：出 Windows 安装包就在 Windows 上跑本脚本
 * （CI 的 electron job 已是三平台 matrix，与 runtime:fetch 的口径一致）。
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "apps", "electron", "build", "host");

rmSync(outDir, { recursive: true, force: true });

// pnpm deploy 从 v10 起要求 inject-workspace-packages，工作区没开 —— 显式 --legacy。
// （Dockerfile 用同一套；那边是真 workspace 部署，这里只为摊平目录。）
execFileSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["--filter", "@greywork/host-node", "deploy", "--prod", "--legacy", outDir],
  {
    cwd: repoRoot,
    stdio: "inherit",
    // Windows 上 pnpm 是 .cmd，Node 20+ 不再允许直接 exec —— 交给 shell 解析。
    shell: process.platform === "win32",
  },
);

const entry = path.join(outDir, "dist", "index.js");
if (!existsSync(entry)) {
  throw new Error(`宿主产物不完整：缺 ${entry}（先跑 pnpm --filter @greywork/host-node build）`);
}

/** 递归找出所有符号链接（含 Windows 的 junction —— Node 也把它们报成 symlink）。 */
function forEachSymlink(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) visit(full);
    else if (entry.isDirectory()) forEachSymlink(full, visit);
  }
}

/**
 * 把符号链接**就地换成真实文件/目录**，悬空的直接删掉。
 *
 * 为什么必须做：`pnpm deploy --legacy` 在 Windows 上会在 `node_modules/.pnpm` 里留一批
 * junction（含指向工作区自己的 `@greywork/host-node` 自引用）。打 NSIS 时 7za 会把悬空
 * junction 当「path not found」记成 warning，而 7za 有 warning 就退出码 1 →
 * electron-builder 判定打包失败。dereference 之后安装包内不再有任何链接，也更抗挪目录。
 */
function materializeSymlinks(root) {
  let replaced = 0;
  let dropped = 0;
  forEachSymlink(root, (link) => {
    let real;
    try {
      real = realpathSync(link);
    } catch {
      // 悬空（自引用 / 指向工作区）：留着只会毒化打包，直接删。
      rmSync(link, { force: true });
      dropped += 1;
      return;
    }
    rmSync(link, { recursive: true, force: true });
    cpSync(real, link, { recursive: true, dereference: true });
    replaced += 1;
  });
  return { replaced, dropped };
}

// 两趟：第一趟替换时会把链接目标里的嵌套链接一并 dereference，第二趟确认已干净。
let stats = { replaced: 0, dropped: 0 };
for (let pass = 0; pass < 2; pass += 1) {
  const round = materializeSymlinks(outDir);
  stats = { replaced: stats.replaced + round.replaced, dropped: stats.dropped + round.dropped };
  if (round.replaced === 0 && round.dropped === 0) break;
}
const leftovers = [];
forEachSymlink(outDir, (link) => leftovers.push(link));
if (leftovers.length > 0) {
  throw new Error(`宿主包内仍有符号链接（${leftovers.length} 个），安装包会打不出来：${leftovers[0]}`);
}

// 解引用后虚拟店（`.pnpm`）里只剩重复副本：顶层 node_modules 已是真实目录，Node 解析
// 不会再走它。留着会把安装包撑大三倍（248M vs 74M），直接删。
const virtualStore = path.join(outDir, "node_modules", ".pnpm");
if (existsSync(virtualStore)) rmSync(virtualStore, { recursive: true, force: true });

console.log(
  `[host-bundle] 已生成 ${path.relative(repoRoot, outDir)}（解引用 ${stats.replaced} 个链接，清除悬空 ${stats.dropped} 个）`,
);
