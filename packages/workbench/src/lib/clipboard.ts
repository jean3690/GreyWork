import { hostClipboard } from "@greywork/host-ipc";

/**
 * 写系统剪贴板 —— 全仓唯一的剪贴板写入入口（eslint 用 no-restricted-properties 守着）。
 *
 * 可靠性按运行时分叉的逻辑收在 `@greywork/host-ipc` 的 `hostClipboard()` 门面里：
 * Tauri 走插件（WebKit 的 `navigator.clipboard` 会静默失败）、Electron 走主进程 clipboard、
 * 浏览器态走 Web API。这里只调门面。
 */
export async function copyText(text: string): Promise<void> {
  await hostClipboard().writeText(text);
}
