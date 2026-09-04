/**
 * 在系统文件管理器中揭示某磁盘路径（交付物卡片「在文件夹中打开」）。
 *
 * 走宿主命令 `reveal_path`（sys.rs → opener 插件）。浏览器态没有磁盘通道，
 * 返回 false 让调用方给出「未落盘」的说明，而不是抛错打断渲染。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@greywork/core";

export async function revealInFolder(path: string): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    await invoke("reveal_path", { path });
    return true;
  } catch (error) {
    // 路径可能已被移动/删除；打开失败不该让卡片崩掉
    console.error("[artifact] 在文件夹中打开失败", error);
    return false;
  }
}
