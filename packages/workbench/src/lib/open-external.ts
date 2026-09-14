/**
 * 用系统默认程序打开文件（预览面板「用系统应用打开」）。
 *
 * 走宿主命令 `open_path`（sys.rs → opener 插件），与 `reveal_path` 同一授权面：
 * 路径必须先获用户授权，渲染端不能拿它探测或打开任意本机路径。
 * 浏览器态没有磁盘通道，返回 false 让调用方给出说明，而不是抛错打断渲染。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@greywork/core";
import type { PreviewTab } from "../stores/preview";

/**
 * tab 的**磁盘孪生路径**，没有则 null。
 *
 * `disk` 源的 path 本身就是绝对路径；`vfs` 源的产物由 deliverArtifact 落盘，
 * 落盘路径记在 tab 的 diskPath 上（没有 = 纯内存文件，无系统程序可开）。
 * `web` 是抓取的 URL，不存在对应的本机文件。
 */
export function resolveTabDiskPath(tab: PreviewTab): string | null {
  if (tab.source === "disk") return tab.path;
  return tab.diskPath ?? null;
}

/** 用系统默认程序打开某磁盘路径；浏览器态或打开失败返回 false（不抛）。 */
export async function openWithSystemApp(path: string): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    await invoke("open_path", { path });
    return true;
  } catch (error) {
    // 路径可能已被移动/删除，或系统里没有能处理该类型的程序；都不该让预览崩掉
    console.error("[preview] 用系统应用打开失败", error);
    return false;
  }
}
