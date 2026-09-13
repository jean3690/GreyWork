/**
 * 网页抓取的宿主通道。
 *
 * 渲染端 CSP `connect-src` 不含外网域名，抓取只能经 Rust 命令（同样也把 SSRF 防线
 * 放在宿主，webview 侧的 JS 无法绕过）。浏览器态没有宿主，调用方需自行降级。
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@greywork/core";

export interface WebFetchResult {
  /** 跟随重定向后的最终地址。 */
  finalUrl: string;
  status: number;
  contentType: string;
  html: string;
}

export const webFetchBackend = {
  /** 仅桌面端可用；浏览器态调用方据此给出提示而非静默失败。 */
  supported: (): boolean => isTauriRuntime(),

  async fetch(url: string): Promise<WebFetchResult> {
    if (!isTauriRuntime()) {
      throw new Error("web fetch requires the desktop runtime (Tauri host)");
    }
    return invoke<WebFetchResult>("web_fetch", { request: { url } });
  },
};
