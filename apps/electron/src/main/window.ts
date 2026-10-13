/**
 * 主窗口：无边框 `BrowserWindow`（对齐 Tauri 的 `decorations: false`），载入 sidecar 托管的 SPA。
 *
 * 拖拽：Electron 没有 Tauri 的 `startDragging()`，改用 CSS `-webkit-app-region`。渲染端的
 * Titlebar 沿用 Tauri 的 `data-tauri-drag-region` 标记，这里在页面加载后注入一段样式把它翻译
 * 成 app-region；交互元素标 no-drag，免得按钮区域把点击吃掉。
 *
 * 防白屏：`show: false` 起手，等 `ready-to-show` 再显示（渲染端还会在首帧后再调一次
 * `hostWindow().show()`，Electron 下那是空操作）。
 */
import { BrowserWindow } from "electron";

import { IPC, WINDOW_LABEL_ARG } from "../shared/channels";
import { sessionToken } from "./auth";
import * as guard from "./close-guard";
import { preloadPath } from "./paths";
import { hideToTray, isCloseToTray, isTrayAvailable, type TrayHost } from "./tray";
import { loadWindowState, saveWindowState, scheduleSaveWindowState } from "./window-state";

export interface MainWindowOptions {
  readonly port: number;
  readonly password: string;
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
  const state = loadWindowState();
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
      url: `http://127.0.0.1:${options.port}/`,
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

  void win.loadURL(`http://127.0.0.1:${options.port}/`);
  return win;
}
