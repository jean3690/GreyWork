#!/usr/bin/env node
// 版本号同步：**真源是仓库根 package.json 的 version**，其余位置由本脚本写入。
//
// 为什么需要它：同一个版本号散落在 4 处（根 / apps/desktop / apps/electron / apps/web 的
// package.json），发版时靠手改，漏一处就会出现「安装包里显示的版本对不上 Release
// 标签」这种很难第一眼发现的偏差。electron-builder 读的是壳自己包内的 package.json。
//
// 用法：node scripts/version-sync.mjs [--check]
//   --check：只校验是否已一致，不一致则退出 1（给 CI / 发版前置用）。
//
// 注意：apps/server 有自己的版本线（服务端可独立发版），刻意不在同步范围。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

/** 读根版本号。 */
function sourceVersion() {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || !pkg.version) {
    throw new Error("根 package.json 缺少 version");
  }
  return pkg.version;
}

/** 各写入点：`read` 取当前值，`write` 落新值。任一为空即视为「读不到」，避免静默跳过。 */
const targets = [
  {
    label: "apps/desktop/package.json",
    file: "apps/desktop/package.json",
    read: (raw) => JSON.parse(raw).version,
    write: (raw, version) => {
      const parsed = JSON.parse(raw);
      parsed.version = version;
      return `${JSON.stringify(parsed, null, 2)}\n`;
    },
  },
  {
    label: "apps/electron/package.json",
    file: "apps/electron/package.json",
    read: (raw) => JSON.parse(raw).version,
    write: (raw, version) => {
      const parsed = JSON.parse(raw);
      parsed.version = version;
      return `${JSON.stringify(parsed, null, 2)}\n`;
    },
  },
  {
    label: "apps/web/package.json",
    file: "apps/web/package.json",
    read: (raw) => JSON.parse(raw).version,
    write: (raw, version) => {
      const parsed = JSON.parse(raw);
      parsed.version = version;
      return `${JSON.stringify(parsed, null, 2)}\n`;
    },
  },
];

const version = sourceVersion();
const drifted = [];

for (const target of targets) {
  const absolute = path.join(repoRoot, target.file);
  const raw = readFileSync(absolute, "utf8");
  const current = target.read(raw);
  if (current === null) throw new Error(`${target.label}：读不到版本号（正则/结构变了？）`);
  if (current === version) continue;
  drifted.push(`${target.label}: ${current} → ${version}`);
  if (!checkOnly) writeFileSync(absolute, target.write(raw, version));
}

if (drifted.length === 0) {
  console.log(`[version-sync] 全部一致：${version}`);
  process.exit(0);
}
if (checkOnly) {
  console.error(`[version-sync] 版本号不一致（真源 根 package.json = ${version}）：`);
  for (const line of drifted) console.error(`  - ${line}`);
  console.error("跑 `pnpm version:sync` 修好再提交。");
  process.exit(1);
}
console.log(`[version-sync] 已同步到 ${version}：`);
for (const line of drifted) console.log(`  - ${line}`);
