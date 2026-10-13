/**
 * 原生文件 / 目录选择器。
 *
 * 与 Tauri 壳的 `fs_pick_files` / `pick_workspace_folder` 对应，但**授权不在这里做** ——
 * 授权账本归 sidecar（服务端）所有，主进程够不着它。渲染端拿到路径后经
 * `fs_authorize_picked_paths` 声明，`@greywork/host-ipc` 的 `hostPicker()` 已把这一步包进
 * 返回值，所以调用方看到的仍是「选完就能用」，与 Tauri 把弹窗和授权放在同一条命令里等价。
 *
 * 弹窗一律挂到主窗上（模态），主窗已关时退回无父窗口的形态 —— 插件悬浮窗不该弹出对话框。
 */
import { dialog } from "electron";
import type { BrowserWindow, OpenDialogOptions } from "electron";

/** 打开文件选择器；取消返回空数组。`purpose` 只做枚举校验（与 Tauri 一致：不设扩展名过滤）。 */
export async function openFiles(
  options: { purpose: string; multiple: boolean },
  win: BrowserWindow | null,
): Promise<string[]> {
  // `media` 是对话附件通道：不限扩展名 —— 通用文件（PDF / 压缩包 / Office 文档）也要能选，
  // 类型判定与限额由渲染端 `lib/attachments.ts` 统一把关。
  if (options.purpose !== "media" && options.purpose !== "workspace") {
    throw new Error(`未知文件选择用途: ${options.purpose}`);
  }
  const properties: OpenDialogOptions["properties"] = options.multiple
    ? ["openFile", "multiSelections"]
    : ["openFile"];
  const dialogOptions: OpenDialogOptions = { title: "选择文件", properties };
  const result = win
    ? await dialog.showOpenDialog(win, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  return result.canceled ? [] : result.filePaths;
}

/** 打开目录选择器；取消返回 null。 */
export async function openDirectory(win: BrowserWindow | null): Promise<string | null> {
  const dialogOptions: OpenDialogOptions = {
    title: "选择工作区文件夹",
    // createDirectory：新建一个文件夹当工作区是很常见的诉求。不设 defaultPath，
    // 交给系统记住上次位置。
    properties: ["openDirectory", "createDirectory"],
  };
  const result = win
    ? await dialog.showOpenDialog(win, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}
