/**
 * 内嵌浏览器的宿主通道。
 *
 * 子 webview 是 Tauri 的能力，**只有桌面态可用**：服务端 / 浏览器预览态没有宿主，
 * `supported()` 为 false，调用方据此禁用入口并给出降级文案（与 web-fetch-backend
 * 同一套约定）。本模块是唯一允许调 `browser_*` 命令、听 `browser:state` 事件的地方。
 *
 * 子 webview 渲染的是不可信远端内容：宿主侧不给它任何 capability，远端 origin 的
 * IPC 被 Tauri 按 origin 拒绝 —— 这里的所有调用都发自主窗口，与页面内容无关。
 */
import { hostApp, hostBrowser } from "@greywork/host-ipc";

/** 槽位矩形：窗口客户区坐标，逻辑像素（CSS px），口径与宿主 `sanitize_rect` 一致。 */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `browser:state` 载荷：子 webview 的实时快照（字段名与宿主 serde 的 camelCase 对齐）。 */
export interface BrowserStateEvent {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * 浏览器态的地址归一化。
 *
 * 与 web-fetch 的 `normalizeUrl` 同一套「补协议头」规则，但**本地服务例外**：
 * `localhost:5173` / `127.0.0.1:3000` 这类补 `http://` —— 它们几乎必然是 dev server，
 * 补 https 会直接 TLS 握手失败（预览本地服务是本功能的一等用例）。
 */
export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/i.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

const host = hostBrowser();

export const browserBackend = {
  /** 仅宿主态可用（Tauri 子 webview / Electron WebContentsView）；其余运行时降级而非静默失败。 */
  supported: (): boolean => host !== null,

  /** 打开（或复用）唯一子视图，导航到 `url` 并对齐到 `rect`。 */
  async open(url: string, rect: BrowserRect): Promise<void> {
    await host?.open(url, rect);
  },

  /** 把子视图对齐到新的槽位矩形（面板宽度 / 窗口尺寸 / 布局变化时）。 */
  async setBounds(rect: BrowserRect): Promise<void> {
    await host?.setBounds(rect);
  },

  /** 显示 / 隐藏子视图。遮挡（宿主弹层打开）与失焦时必须藏，否则原生层盖住一切。 */
  async setVisible(visible: boolean): Promise<void> {
    await host?.setVisible(visible);
  },

  async navigate(url: string): Promise<void> {
    await host?.navigate(url);
  },

  async back(): Promise<void> {
    await host?.back();
  },

  async forward(): Promise<void> {
    await host?.forward();
  },

  async reload(): Promise<void> {
    await host?.reload();
  },

  async stop(): Promise<void> {
    await host?.stop();
  },

  /** 销毁子视图（浏览器标签被关掉时）。 */
  async close(): Promise<void> {
    await host?.close();
  },

  /**
   * 订阅宿主回推的状态（URL / 标题 / loading / 前进后退可用性）。
   * 返回解绑函数；非宿主态直接返回 no-op，调用方无需先判 supported。
   */
  async onState(callback: (state: BrowserStateEvent) => void): Promise<() => void> {
    if (!host) return () => {};
    return host.onState(callback);
  },
};

/**
 * 用系统浏览器打开地址（走宿主应用面 `hostApp().openExternal`；无原生宿主回落 `window.open`）。
 * 与 update-backend 的处理同构 —— 那份是更新检查专用，这里面向预览面板。
 */
export async function openInSystemBrowser(url: string): Promise<void> {
  const app = hostApp();
  if (app) {
    await app.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}
