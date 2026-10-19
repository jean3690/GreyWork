#!/usr/bin/env node
import { execSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function run(cmd) {
  try {
    execSync(cmd, { stdio: "ignore" });
  } catch {
    // ignore
  }
}

// 1) 清理相关进程
run("pkill -f vite 2>/dev/null");
run("pkill -f electron-vite 2>/dev/null");
run("pkill -f electron 2>/dev/null");
run("pkill -f greywork 2>/dev/null");

// 2) 等端口释放
await new Promise((r) => setTimeout(r, 1000));

// 3) 清理 Vite 缓存（最关键）
const cacheDirs = [
  ".vite",
  "node_modules/.vite",
  "packages/workbench/node_modules/.vite",
  "apps/electron/node_modules/.vite",
  "apps/electron/.vite",
  "apps/desktop/.vite",
];
for (const dir of cacheDirs) {
  const p = join(root, dir);
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// 4) 启动 electron:dev
const child = spawn("pnpm", ["electron:dev"], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
