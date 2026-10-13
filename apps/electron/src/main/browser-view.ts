/**
 * 内嵌浏览器子视图（对齐 Tauri 壳的 `browser*.rs` 子 webview）。
 *
 * 预览面板的「浏览器」标签需要一块**原生层**叠在渲染层之上：它不是 iframe（远端的 X-Frame
 * Options / CSP 会拦），而是主窗 `contentView` 上的一个 `WebContentsView`，位置由渲染端实时
 * 算好矩形推过来。
 *
 * 安全：渲染的是**不可信远端内容** —— 独立 session（与应用会话隔离，避免远端页面碰到
 * `gw_session` cookie）、禁 Node、开 sandbox；拒新窗、只放行 http/https 导航、权限请求一律拒。
 *
 * 与 Tauri 的差异：Linux 上 Tauri 需要 `wry` 手搓（GTK 的 `add_child` 坐标失效），Electron 的
 * `setBounds` 直接生效，无需那套绕行。
 */
import { WebContentsView, type BrowserWindow } from "electron";

import { IPC } from "../shared/channels";
import { sanitizeRect } from "../shared/rect";

const PARTITION = "gw-browser";

let view: WebContentsView | null = null;

/** 把子视图当前状态合并推给主窗（对齐 Tauri 的 `browser:state` 事件）。 */
function emitState(win: BrowserWindow): void {
  if (!view || win.isDestroyed()) return;
  const contents = view.webContents;
  win.webContents.send(IPC.browser.state, {
    url: contents.getURL(),
    title: contents.getTitle(),
    loading: contents.isLoading(),
    canGoBack: contents.canGoBack(),
    canGoForward: contents.canGoForward(),
  });
}

/** 取（或建）唯一子视图并挂到主窗。 */
function ensureView(win: BrowserWindow): WebContentsView {
  if (view && !view.webContents.isDestroyed()) return view;
  const created = new WebContentsView({
    webPreferences: {
      // 独立 session：远端页面看不到应用会话的 cookie/存储。
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const contents = created.webContents;
  contents.on("did-start-loading", () => emitState(win));
  contents.on("did-stop-loading", () => emitState(win));
  contents.on("did-navigate", () => emitState(win));
  contents.on("did-navigate-in-page", () => emitState(win));
  contents.on("page-title-updated", () => emitState(win));

  // 不可信内容：不开新窗，只放行 http(s) 导航，权限请求一律拒。
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!/^https?:\/\//i.test(url)) event.preventDefault();
  });
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  win.contentView.addChildView(created);
  view = created;
  return created;
}

/** 销毁子视图（浏览器标签关闭 / 主窗关闭）。 */
export function destroyBrowserView(win: BrowserWindow | null): void {
  if (!view) return;
  const current = view;
  view = null;
  if (win && !win.isDestroyed()) win.contentView.removeChildView(current);
  if (!current.webContents.isDestroyed()) current.webContents.close();
}

/** 打开（或复用）唯一子视图，导航到 `url` 并对齐到 `rect`。 */
export function openBrowser(win: BrowserWindow, url: string, rect: unknown): void {
  const created = ensureView(win);
  const bounds = sanitizeRect(rect);
  if (bounds) created.setBounds(bounds);
  created.setVisible(true);
  // ERR_ABORTED（快速改址）无害；状态由 did-* 事件回推，这里吞掉 reject。
  void created.webContents.loadURL(url).catch(() => undefined);
}

export function setBrowserBounds(rect: unknown): void {
  const bounds = sanitizeRect(rect);
  if (bounds && view) view.setBounds(bounds);
}

export function setBrowserVisible(visible: boolean): void {
  view?.setVisible(visible);
}

export function navigateBrowser(url: string): void {
  if (view) void view.webContents.loadURL(url).catch(() => undefined);
}

export function browserGoBack(): void {
  if (view?.webContents.canGoBack()) view.webContents.goBack();
}

export function browserGoForward(): void {
  if (view?.webContents.canGoForward()) view.webContents.goForward();
}

export function browserReload(): void {
  view?.webContents.reload();
}

export function browserStop(): void {
  view?.webContents.stop();
}
