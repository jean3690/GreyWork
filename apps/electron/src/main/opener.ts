/**
 * 系统 opener 三件套（对齐 Tauri 壳 `sys.rs` → `tauri-plugin-opener`）。
 *
 * `openPath` / `revealPath` 作用在任何本机路径上；「路径是否已被用户授权」的判定在渲染端
 * 的工作区授权面（`WorkspaceFsAccess`）里，渲染端不会拿未授权路径来调 —— 这里只做转发。
 */
import { shell } from "electron";

/** 用系统默认浏览器打开外部链接。 */
export async function openExternal(url: string): Promise<void> {
  await shell.openExternal(url);
}

/** 用系统默认程序打开磁盘路径（失败不抛，返回错误串；门面侧按 void 处理）。 */
export async function openPath(target: string): Promise<void> {
  const error = await shell.openPath(target);
  if (error) console.warn(`[opener] 用系统应用打开失败：${target} — ${error}`);
}

/** 在系统文件管理器中揭示磁盘路径。 */
export function revealPath(target: string): void {
  shell.showItemInFolder(target);
}
