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
import { existsSync, rmSync } from "node:fs";
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
console.log(`[host-bundle] 已生成 ${path.relative(repoRoot, outDir)}`);
