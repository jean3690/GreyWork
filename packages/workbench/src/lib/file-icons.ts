/**
 * 文件/目录图标：由 vscode-icons-js 把文件名/目录名映射成 vscode-icons 图集里的 SVG 名，
 * 再拼成**根路径** `/vscode-icons/` 下的静态资源 URL。
 *
 * ⚠️ 下面的 `ICON_BASE` 是**运行时字符串字面量**，Vite 的 `base` 重写不到它 —— 所以这套图标
 * 必须真的躺在部署的根路径上，且整个部署里只有 base 为 `/` 的那一端会把它们送进产物根
 * （各 app 的 `publicDir` 都指向 `packages/workbench/public/`）。非根 base 的前端请求到的
 * `/vscode-icons/…` 由根那一端回答；错了不报错，只是图标不显示。
 *
 * vscode-icons-js（v11.6.1）对应 vscode-icons 扩展 11.6.0 的图集，图集已按该版本落盘到
 * packages/workbench/public/vscode-icons/（1084 个 svg，名称一一对应）。函数总是返回字符串，
 * 命中不了就回落到 default_* 图标 —— 树里任何一行都该有个图标可显示。
 *
 * 结果用 Map 缓存：树展开后每行都会查一遍，同一文件名/目录名反复查询没必要重复做匹配。
 * 缓存有界（LRU）：大仓库里文件名/目录名几乎是无限的，不设上限就是随浏览单调增长。
 */
import { getIconForFile, getIconForFolder, getIconForOpenFolder } from "vscode-icons-js";
import { createBoundedMap } from "./bounded-map";

const ICON_BASE = "/vscode-icons/";

/** 单个缓存的上限。图标 URL 本身很轻，这里只是兜住"无限文件名"的增长。 */
const ICON_CACHE_LIMIT = 512;

const FILE_CACHE = createBoundedMap<string, string>(ICON_CACHE_LIMIT);
const FOLDER_CACHE = createBoundedMap<string, string>(ICON_CACHE_LIMIT);
const FOLDER_OPEN_CACHE = createBoundedMap<string, string>(ICON_CACHE_LIMIT);

function urlOf(icon: string | undefined, fallback: string): string {
  return `${ICON_BASE}${icon || fallback}`;
}

/** 文件名 → 图标 URL（`.js`、`main.cpp`、`nginx.conf` 这类都按 vscode-icons 规则匹配）。 */
export function fileIconUrl(name: string): string {
  const cached = FILE_CACHE.get(name);
  if (cached) return cached;
  const url = urlOf(getIconForFile(name), "default_file.svg");
  FILE_CACHE.set(name, url);
  return url;
}

/** 目录名 → 图标 URL；`open` 决定用闭合还是展开态（展开态由 "_opened" 后缀派生）。 */
export function folderIconUrl(name: string, open: boolean): string {
  const cache = open ? FOLDER_OPEN_CACHE : FOLDER_CACHE;
  const cached = cache.get(name);
  if (cached) return cached;
  const url = urlOf(open ? getIconForOpenFolder(name) : getIconForFolder(name), open ? "default_folder_opened.svg" : "default_folder.svg");
  cache.set(name, url);
  return url;
}
