import { hostPicker } from "@greywork/host-ipc";

/**
 * 挑选工作区文件夹：
 * - 有原生选择器（Tauri / Electron）时只接受宿主系统对话框返回的授权路径；
 * - 纯服务端 / 浏览器 / 测试态没有本机路径权限，保留路径输入用于预览态数据。
 */
export async function pickWorkspaceFolder(): Promise<string | null> {
  const picker = hostPicker();
  if (picker) return await picker.pickWorkspaceFolder();
  const typed = window.prompt("选择工作区文件夹（浏览器预览路径）");
  return typed?.trim() || null;
}
