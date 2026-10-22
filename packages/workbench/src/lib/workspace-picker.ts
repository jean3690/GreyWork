import { hostPicker } from "@greywork/host-ipc";
import { requestPathInput } from "./path-prompt";

/**
 * 挑选工作区文件夹：
 * - 有原生选择器（Electron 壳）时只接受宿主系统对话框返回的授权路径；
 * - 纯服务端 / 浏览器态拿不到本机路径（自托管部署下目录在另一台机器上），改为在应用内
 *   问「服务端上的绝对路径」。**不能再用 `window.prompt`**：Chromium 已不实现它，
 *   调用直接抛错，表现为「添加工作区 / 绑定文件夹」点了毫无反应。
 */
export async function pickWorkspaceFolder(): Promise<string | null> {
  const picker = hostPicker();
  if (picker) return await picker.pickWorkspaceFolder();
  return await requestPathInput();
}
