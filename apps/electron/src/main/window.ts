/**
 * 主窗口：无边框 `BrowserWindow`（对齐 Tauri 的 `decorations: false`），载入 `options.origin`
 * 下的 SPA —— 生产是 sidecar 同源托管，dev 热更态是 Vite dev server（见 `MainWindowOptions.origin`）。
 *
 * 拖拽：Electron 没有 Tauri 的 `startDragging()`，改用 CSS `-webkit-app-region`。渲染端的
 * Titlebar 沿用 Tauri 的 `data-tauri-drag-region` 标记，这里在页面加载后注入一段样式把它翻译
 * 成 app-region；交互元素标 no-drag，免得按钮区域把点击吃掉。
 *
 * 防白屏：`show: false` 起手，等 `ready-to-show` 再显示（渲染端还会在首帧后再调一次
 * `hostWindow().show()`，Electron 下那是空操作）。
 */
import { BrowserWindow, screen } from "electron";

import { IPC, WINDOW_LABEL_ARG } from "../shared/channels";
import { placeWindow } from "../shared/window-placement";
import { sessionToken } from "./auth";
import * as guard from "./close-guard";
import { guardNavigation } from "./navigation";
import { preloadPath } from "./paths";
import { hideToTray, isCloseToTray, isTrayAvailable, type TrayHost } from "./tray";
import { loadWindowState, saveWindowState, scheduleSaveWindowState } from "./window-state";

export interface MainWindowOptions {
  /** sidecar 端口：`/api/login` 换 token 用（与渲染端 origin 未必同端口，见 `origin`）。 */
  readonly port: number;
  readonly password: string;
  /**
   * 渲染端载入的 origin（含协议与端口）。热更态是 Vite dev server，否则是 sidecar 同源。
   *
   * cookie 也写在这个 origin 上：cookie 按 **host** 存（端口无关），所以它必须与 `loadURL`
   * 的 host 逐字一致，否则登录门会弹出来（见 `dev-server-spec` 里对 `127.0.0.1` 的说明）。
   */
  readonly origin: string;
  /** 是否自动打开 DevTools（热更调试用，默认关）。 */
  readonly openDevTools?: boolean;
  /** 关闭到托盘时要用的宿主回调（托盘本体在 tray.ts）。 */
  readonly tray: TrayHost;
}

const DRAG_CSS = `
[data-tauri-drag-region]{ -webkit-app-region: drag; }
[data-tauri-drag-region] :is(button,a,input,select,textarea,[role=button],[contenteditable]){ -webkit-app-region: no-drag; }
[data-testid="plugin-window"]{ -webkit-app-region: drag; }
[data-testid="plugin-window"] button{ -webkit-app-region: no-drag; }
`;

export async function createMainWindow(options: MainWindowOptions): Promise<BrowserWindow> {
  // 显示器拓扑可能变过（拔掉外接屏 / 改分辨率）：越界的坐标要拉回来，否则窗口起在屏幕外。
  const state = placeWindow(
    loadWindowState(),
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    backgroundColor: "#000000",
    show: false,
    webPreferences: {
      preload: preloadPath(),
      // 渲染端是纯 Web SPA，只走 HTTP/WS，不需要 Node。
      nodeIntegration: false,
      contextIsolation: true,
      // sandbox 关掉是为了让 preload 能复用相对模块（shared/channels）；主窗载入的是本地
      // sidecar 托管的自家 SPA，非不可信远端内容。渲染端仍拿不到 Node。
      sandbox: false,
      // 让 preload 报出正确的窗口 label（渲染端 plugin-window 逻辑按 label 反查）。
      additionalArguments: [`--${WINDOW_LABEL_ARG}main`],
    },
  });
  if (state.maximized) win.maximize();

  // 自家 SPA 之外一律不许导航（远端页面会继承 preload 的宿主能力）。
  guardNavigation(win.webContents, options.origin);

  win.once("ready-to-show", () => win.show());
  win.webContents.on("did-finish-load", () => void win.webContents.insertCSS(DRAG_CSS));

  const emitResized = (): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.window.resized);
  };
  win.on("resize", () => {
    emitResized();
    scheduleSaveWindowState(win);
  });
  win.on("maximize", emitResized);
  win.on("unmaximize", emitResized);
  win.on("move", () => scheduleSaveWindowState(win));
  win.on("focus", () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.window.focus, true);
  });
  win.on("blur", () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.window.focus, false);
  });

  // 渲染进程崩溃：先重载一次（多数是瞬时故障）；同一窗口再崩就销毁，避免无限重载循环。
  let reloadedAfterCrash = false;
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit" || win.isDestroyed()) return;
    console.error(`[window] 渲染进程退出（${details.reason}）`);
    if (reloadedAfterCrash) {
      win.destroy();
      return;
    }
    reloadedAfterCrash = true;
    win.reload();
  });
  win.on("unresponsive", () => console.warn("[window] 渲染进程无响应"));

  // 关闭守卫：守卫已放行 → 真关；有未保存改动 → 拦下交渲染端决定（带 2s 兜底）；
  // 有托盘且开了「关闭到托盘」→ 隐藏；再否则放行。
  win.on("close", (event) => {
    if (guard.isReleased()) return;
    if (guard.shouldInterceptClose()) {
      event.preventDefault();
      guard.handCloseToRenderer(win, () => win.destroy());
      return;
    }
    if (isTrayAvailable() && isCloseToTray()) {
      event.preventDefault();
      hideToTray(options.tray);
    }
  });
  win.on("close", () => saveWindowState(win));

  // 自动登录：拿本机密码换 token，塞进窗口 session 的同源 HttpOnly cookie；渲染端启动自省
  // `/api/session` 即已认证，不弹登录门。换不到就回落到登录门。
  const token = await sessionToken(options.port, options.password);
  if (token !== null) {
    await win.webContents.session.cookies.set({
      url: `${options.origin}/`,
      name: "gw_session",
      value: token,
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
    console.log("[auth] 自动登录成功：已注入同源会话 cookie");
  } else {
    console.warn("[auth] 自动登录失败：窗口将回落到登录门");
  }

  if (options.openDevTools) win.webContents.openDevTools({ mode: "detach" });
  void win.loadURL(`${options.origin}/`);
  return win;
}
