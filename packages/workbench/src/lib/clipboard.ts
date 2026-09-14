import { isTauriRuntime } from "@greywork/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * 写系统剪贴板 —— 全仓唯一的剪贴板写入入口（eslint 用 no-restricted-properties 守着）。
 *
 * **桌面必须走插件**：Tauri 的两个 WebKit WebView（WKWebView / WebKitGTK）上
 * `navigator.clipboard.writeText` 会静默 resolve 但不写入系统剪贴板 —— 界面显示
 * 「已复制」，剪贴板里却什么都没有。浏览器态反过来只能走 Web API（没有 IPC 宿主，
 * 插件必然失败），而真浏览器上它是可靠的。
 *
 * 所以这不是「优先插件、失败回退」的降级链，而是**按运行时选可靠的那条路**：
 * 两条分支各自在自己的环境里都可靠，桌面永远走不到 Web API 那一行。
 */
export async function copyText(text: string): Promise<void> {
  if (isTauriRuntime()) {
    await writeText(text);
    return;
  }
  // 浏览器态没有 IPC 宿主，插件必然失败；真浏览器上 Web API 可靠。
  // 这条 disable 是规则注释里预留的出口：按运行时分叉，不是绕过规则走不可靠路径。
  // eslint-disable-next-line no-restricted-properties
  await navigator.clipboard.writeText(text);
}
