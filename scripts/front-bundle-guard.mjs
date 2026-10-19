#!/usr/bin/env node
/**
 * 前端产物体积/剪枝守卫。
 *
 * 锁的是「一个后端、多个前端」最容易静默失效的那一环：`apps/web` 的产物里不该出现
 * 它没有启用的特性（team / assistants / channels）。这条曾经真的坏过 —— `currentFront()`
 * 带全量缺省时，web 与 desktop 的 chunk 数完全一致、体积差 <0.02%，而所有单测与 e2e 都是绿的
 * （它们验的是运行期行为，不是产物内容）。
 *
 * 判据两条，都直接看产物：
 * 1. web 的 assets 里不存在被排除特性的路由 chunk（文件名带组件名，Vite 的命名稳定）；
 * 2. web 的任何 JS 里都没有 `ALL_FEATURES_FRONT` 的 label（全量集合只在桌面端可达）。
 * 反向再确认 desktop 确实有 TeamView chunk —— 否则第 1 条在「两端都没构建」时也会假绿。
 *
 * 依赖 `pnpm build` 的产物；CI 里排在构建之后。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const assetsOf = (app) => path.join(root, "apps", app, "dist", "assets");

const EXCLUDED = ["TeamView", "AssistantsView", "RemoteConversationView"];
const DESKTOP_LABEL = "桌面端（全特性）";

function filesOf(dir) {
  try {
    return readdirSync(dir);
  } catch {
    throw new Error(`找不到产物目录 ${dir}：先跑 pnpm build`);
  }
}

const webFiles = filesOf(assetsOf("web"));
const desktopFiles = filesOf(assetsOf("desktop"));

const leaked = EXCLUDED.filter((name) => webFiles.some((file) => file.startsWith(`${name}-`)));
if (leaked.length > 0) {
  throw new Error(`apps/web 产物里出现了未启用特性的 chunk：${leaked.join(", ")}（特性集被 barrel 或缺省前端拖回来了）`);
}

for (const file of webFiles.filter((name) => name.endsWith(".js"))) {
  if (readFileSync(path.join(assetsOf("web"), file), "utf8").includes(DESKTOP_LABEL)) {
    throw new Error(`apps/web 的 ${file} 里出现了「${DESKTOP_LABEL}」：全量前端集合进了 web 产物`);
  }
}

const desktopHasTeam = desktopFiles.some((file) => file.startsWith("TeamView-"));
if (!desktopHasTeam) {
  throw new Error("apps/desktop 产物里没有 TeamView chunk：桌面端特性集异常，或产物不是最新构建");
}

console.log(`front-bundle-guard: OK（web ${webFiles.length} 个资源，已排除 ${EXCLUDED.join(" / ")}）`);
