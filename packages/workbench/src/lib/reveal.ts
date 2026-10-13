/**
 * 在系统文件管理器中揭示某磁盘路径（交付物卡片「在文件夹中打开」）。
 *
 * 走宿主应用面 `hostApp().revealPath`（Tauri: `reveal_path` 命令 → opener 插件；
 * Electron: 主进程 `shell.showItemInFolder`）。无原生宿主（纯服务端 / 浏览器）返回
 * false 让调用方给出「未落盘」的说明，而不是抛错打断渲染。
 */

import { hostApp } from "@greywork/host-ipc";

export async function revealInFolder(path: string): Promise<boolean> {
  const app = hostApp();
  if (!app) return false;
  try {
    await app.revealPath(path);
    return true;
  } catch (error) {
    // 路径可能已被移动/删除；打开失败不该让卡片崩掉
    console.error("[artifact] 在文件夹中打开失败", error);
    return false;
  }
}
