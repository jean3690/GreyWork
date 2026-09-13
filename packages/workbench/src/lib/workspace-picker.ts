import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@greywork/core";

/**
 * 挑选工作区文件夹：
 * - 桌面端只接受 Rust 系统目录对话框返回的宿主授权路径；
 * - 浏览器/测试态没有本机路径权限，保留路径输入用于预览态数据。
 */
export async function pickWorkspaceFolder(): Promise<string | null> {
  if (isTauriRuntime()) return await invoke<string | null>("pick_workspace_folder");
  const typed = window.prompt("选择工作区文件夹（浏览器预览路径）");
  return typed?.trim() || null;
}
