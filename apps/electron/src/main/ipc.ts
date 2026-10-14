/**
 * 主进程 IPC 注册：把 preload 暴露的白名单通道接到具体实现上。
 *
 * 通道名一律取自 `shared/channels.ts`（单一真源），与 `preload/index.ts` 逐条对应。
 */
import { app, clipboard, ipcMain } from "electron";
import type { BrowserWindow } from "electron";

import { IPC } from "../shared/channels";
import * as browserView from "./browser-view";
import * as guard from "./close-guard";
import { notifyPlugin, sendSystemNotification } from "./notify";
import { openDirectory, openFiles } from "./picker";
import { closePluginWindow, openPluginWindow } from "./plugin-window";
import { openExternal, openPath, revealPath } from "./opener";
import { applyTrayLabels, hideToTray, isCloseToTray, isTrayAvailable, setCloseToTray, type TrayHost } from "./tray";

export interface IpcHost {
  /** 当前主窗（可能尚未创建 / 已关闭）。 */
  window: () => BrowserWindow | null;
  /** 渲染端当前 origin：插件悬浮窗据此从同一源载入 SPA（热更态是 Vite，否则 sidecar 同源）。 */
  rendererOrigin: () => string;
  /** 真正退出应用（守卫放行后）。 */
  quit: () => void;
}

/** 入参一律来自渲染端 IPC，做最小类型校验后再用。 */
function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

/** 把 IpcHost 适配成 tray.ts 需要的宿主面。 */
function trayHost(host: IpcHost): TrayHost {
  return { window: host.window, quit: host.quit };
}

export function registerIpc(host: IpcHost): void {
  /* ===== 窗口控制 ===== */
  ipcMain.handle(IPC.window.minimize, () => host.window()?.minimize());
  ipcMain.handle(IPC.window.toggleMaximize, () => {
    const win = host.window();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle(IPC.window.close, () => host.window()?.close());
  ipcMain.handle(IPC.window.isMaximized, () => host.window()?.isMaximized() ?? false);

  /* ===== 关闭—退出守卫 ===== */
  ipcMain.handle(IPC.closeGuard.syncUnsaved, (_event, unsaved: unknown) => {
    guard.setUnsaved(unsaved === true);
  });
  ipcMain.handle(IPC.closeGuard.requestClose, () => {
    // 渲染端已放行：有托盘且开了「关闭到托盘」则隐藏，否则清守卫后正常关窗
    // （关窗回调里 guard.isReleased() 为真，不再拦）。
    guard.release();
    const win = host.window();
    if (!win) return;
    if (isTrayAvailable() && isCloseToTray()) {
      hideToTray(trayHost(host));
      return;
    }
    win.close();
  });
  ipcMain.handle(IPC.closeGuard.confirmExit, () => {
    guard.release();
    host.quit();
  });

  /* ===== 剪贴板：走主进程 electron.clipboard（Chromium 下可靠，不触发 Web 权限提示）===== */
  ipcMain.handle(IPC.clipboard.writeText, (_event, text: unknown) => clipboard.writeText(asString(text)));
  ipcMain.handle(IPC.clipboard.readText, () => clipboard.readText());
  ipcMain.handle(IPC.clipboard.readImagePng, () => {
    const image = clipboard.readImage();
    return image.isEmpty() ? null : image.toPNG();
  });

  /* ===== 应用信息 / 外部打开 ===== */
  ipcMain.handle(IPC.app.version, () => app.getVersion());
  ipcMain.handle(IPC.app.homeDir, () => app.getPath("home"));
  ipcMain.handle(IPC.app.openExternal, (_event, url: unknown) => (typeof url === "string" ? openExternal(url) : undefined));
  ipcMain.handle(IPC.app.revealPath, (_event, target: unknown) => {
    if (typeof target === "string") revealPath(target);
  });
  ipcMain.handle(IPC.app.openPath, (_event, target: unknown) => (typeof target === "string" ? openPath(target) : undefined));

  /* ===== 系统托盘（本体在 tray.ts）===== */
  ipcMain.handle(IPC.tray.available, () => isTrayAvailable());
  ipcMain.handle(IPC.tray.setCloseToTray, (_event, enabled: unknown) => setCloseToTray(enabled === true));
  ipcMain.handle(IPC.tray.setLabels, (_event, labels: unknown) => applyTrayLabels(trayHost(host), labels));

  /* ===== 内嵌浏览器子视图（WebContentsView，本体在 browser-view.ts）===== */
  ipcMain.handle(IPC.browser.open, (_event, url: unknown, rect: unknown) => {
    const win = host.window();
    if (win && typeof url === "string") browserView.openBrowser(win, url, rect);
  });
  ipcMain.handle(IPC.browser.setBounds, (_event, rect: unknown) => browserView.setBrowserBounds(rect));
  ipcMain.handle(IPC.browser.setVisible, (_event, visible: unknown) => browserView.setBrowserVisible(visible === true));
  ipcMain.handle(IPC.browser.navigate, (_event, url: unknown) => {
    if (typeof url === "string") browserView.navigateBrowser(url);
  });
  ipcMain.handle(IPC.browser.back, () => browserView.browserGoBack());
  ipcMain.handle(IPC.browser.forward, () => browserView.browserGoForward());
  ipcMain.handle(IPC.browser.reload, () => browserView.browserReload());
  ipcMain.handle(IPC.browser.stop, () => browserView.browserStop());
  ipcMain.handle(IPC.browser.close, () => browserView.destroyBrowserView(host.window()));

  /* ===== 插件宿主面：系统通知 + 悬浮窗（本体在 notify.ts / plugin-window.ts）===== */
  ipcMain.handle(IPC.plugins.notify, (_event, request: unknown) => {
    if (!request || typeof request !== "object") throw new Error("notify request must be an object");
    const { pluginId, title, body } = request as Record<string, unknown>;
    if (typeof pluginId !== "string" || typeof title !== "string" || typeof body !== "string") {
      throw new Error("notify requires string pluginId / title / body");
    }
    return notifyPlugin({ pluginId, title, body });
  });
  ipcMain.handle(IPC.plugins.openWindow, (_event, pluginId: unknown) => {
    if (typeof pluginId === "string") openPluginWindow(pluginId, host.rendererOrigin());
  });
  ipcMain.handle(IPC.plugins.closeWindow, (_event, pluginId: unknown) => {
    if (typeof pluginId === "string") closePluginWindow(pluginId);
  });

  /* ===== 通用系统通知（不带归属前缀；服务端的 `host://notify` 事件落到这里）===== */
  ipcMain.handle(IPC.notify.system, (_event, title: unknown, body: unknown) => {
    if (typeof title !== "string" || typeof body !== "string") return;
    sendSystemNotification(title, body);
  });

  /* ===== 原生文件 / 目录选择器（本体在 picker.ts）=====
   * 只负责弹窗取路径；把路径写进授权账本由渲染端调 `fs_authorize_picked_paths` 完成
   * （账本归 sidecar 所有，主进程够不着）。见 picker.ts 的说明。 */
  ipcMain.handle(IPC.picker.openFiles, (_event, options: unknown) => {
    if (!options || typeof options !== "object") throw new Error("openFiles requires options");
    const { purpose, multiple } = options as Record<string, unknown>;
    if (typeof purpose !== "string") throw new Error("openFiles requires a string purpose");
    return openFiles({ purpose, multiple: multiple === true }, host.window());
  });
  ipcMain.handle(IPC.picker.openDirectory, () => openDirectory(host.window()));
}
