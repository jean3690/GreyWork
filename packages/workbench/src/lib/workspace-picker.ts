import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@greywork/core";

/**
 * 挑选工作区文件夹：
 * - 桌面端走系统目录对话框（Rust store_fs::pick_workspace_folder）；
 * - 浏览器/测试态回落为路径输入框（桌面宿主校验绝对路径与存在性，见 store_fs::validate_folder）。
 */
export async function pickWorkspaceFolder(): Promise<string | null> {
  if (isTauriRuntime()) {
    try {
      return await invoke<string | null>("pick_workspace_folder");
    } catch {
      // 对话框异常（无窗口等）→ 回落路径输入，不让添加入口静默失效
    }
  }
  const typed = window.prompt("选择工作区文件夹（粘贴绝对路径；桌面端可点「添加」走系统目录对话框）");
  return typed?.trim() || null;
}
