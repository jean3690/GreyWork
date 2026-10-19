/**
 * 主进程 IPC 注册：把 preload 暴露的白名单通道接到具体实现上。
 *
 * 通道名一律取自 `shared/channels.ts`（单一真源），与 `preload/index.ts` 逐条对应。
 *
 * **来源校验**：所有通道都只接受与 `rendererOrigin` 同源的调用。preload 桥只注入自家
 * SPA，但导航被绕过 / 未来加了远端内容时，这一层是最后一道闸 —— 远端页面不该能调
 * `openPath`、剪贴板或托盘。
 */
import { app, clipboard, ipcMain } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

import { IPC } from "../shared/channels";
import { isSameOrigin } from "../shared/navigation";
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

/** 通知被点击时把主窗叫回来（可能已隐藏到托盘 / 最小化）。 */
function focusMainWindow(host: IpcHost): void {
  const win = host.window();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** 调用方是否来自渲染端 origin（主窗 / 插件悬浮窗 / dev server 同源）。 */
function isTrustedSender(event: IpcMainInvokeEvent, origin: string): boolean {
  const url = event.senderFrame?.url;
  return typeof url === "string" && isSameOrigin(url, origin);
}

export function registerIpc(host: IpcHost): void {
  /** 统一包一层来源校验；不可信调用直接拒绝（渲染端拿到 rejected promise）。 */
  const on = (channel: string, handler: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!isTrustedSender(event, host.rendererOrigin())) {
        console.warn(`[ipc] 拒绝不可信来源的调用：${channel}（${event.senderFrame?.url ?? "unknown"}）`);
        throw new Error("IPC call from an untrusted origin");
      }
      return handler(...args);
    });
  };

  /* ===== 窗口控制 ===== */
  on(IPC.window.minimize, () => host.window()?.minimize());
  on(IPC.window.toggleMaximize, () => {
    const win = host.window();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  on(IPC.window.close, () => host.window()?.close());
  on(IPC.window.isMaximized, () => host.window()?.isMaximized() ?? false);

  /* ===== 关闭—退出守卫 ===== */
  on(IPC.closeGuard.syncUnsaved, (unsaved) => {
    guard.setUnsaved(unsaved === true);
  });
  on(IPC.closeGuard.requestClose, () => {
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
  on(IPC.closeGuard.confirmExit, () => {
    guard.release();
    host.quit();
  });

  /* ===== 剪贴板：走主进程 electron.clipboard（Chromium 下可靠，不触发 Web 权限提示）===== */
  on(IPC.clipboard.writeText, (text) => clipboard.writeText(asString(text)));
  on(IPC.clipboard.readText, () => clipboard.readText());
  on(IPC.clipboard.readImagePng, () => {
    const image = clipboard.readImage();
    return image.isEmpty() ? null : image.toPNG();
  });

  /* ===== 应用信息 / 外部打开 ===== */
  on(IPC.app.version, () => app.getVersion());
  on(IPC.app.homeDir, () => app.getPath("home"));
  on(IPC.app.openExternal, (url) => (typeof url === "string" ? openExternal(url) : undefined));
  on(IPC.app.revealPath, (target) => {
    if (typeof target === "string") revealPath(target);
  });
  on(IPC.app.openPath, (target) => (typeof target === "string" ? openPath(target) : undefined));

  /* ===== 系统托盘（本体在 tray.ts）===== */
  on(IPC.tray.available, () => isTrayAvailable());
  on(IPC.tray.setCloseToTray, (enabled) => setCloseToTray(enabled === true));
  on(IPC.tray.setLabels, (labels) => applyTrayLabels(trayHost(host), labels));

  /* ===== 内嵌浏览器子视图（WebContentsView，本体在 browser-view.ts）===== */
  on(IPC.browser.open, (url, rect) => {
    const win = host.window();
    if (win && typeof url === "string") browserView.openBrowser(win, url, rect);
  });
  on(IPC.browser.setBounds, (rect) => browserView.setBrowserBounds(rect));
  on(IPC.browser.setVisible, (visible) => browserView.setBrowserVisible(visible === true));
  on(IPC.browser.navigate, (url) => {
    if (typeof url === "string") browserView.navigateBrowser(url);
  });
  on(IPC.browser.back, () => browserView.browserGoBack());
  on(IPC.browser.forward, () => browserView.browserGoForward());
  on(IPC.browser.reload, () => browserView.browserReload());
  on(IPC.browser.stop, () => browserView.browserStop());
  on(IPC.browser.close, () => browserView.destroyBrowserView(host.window()));

  /* ===== 插件宿主面：系统通知 + 悬浮窗（本体在 notify.ts / plugin-window.ts）===== */
  on(IPC.plugins.notify, (request) => {
    if (!request || typeof request !== "object") throw new Error("notify request must be an object");
    const { pluginId, title, body } = request as Record<string, unknown>;
    if (typeof pluginId !== "string" || typeof title !== "string" || typeof body !== "string") {
      throw new Error("notify requires string pluginId / title / body");
    }
    return notifyPlugin({ pluginId, title, body }, () => focusMainWindow(host));
  });
  on(IPC.plugins.openWindow, (pluginId) => {
    if (typeof pluginId === "string") openPluginWindow(pluginId, host.rendererOrigin());
  });
  on(IPC.plugins.closeWindow, (pluginId) => {
    if (typeof pluginId === "string") closePluginWindow(pluginId);
  });

  /* ===== 通用系统通知（不带归属前缀；服务端的 `host://notify` 事件落到这里）===== */
  on(IPC.notify.system, (title, body) => {
    if (typeof title !== "string" || typeof body !== "string") return;
    sendSystemNotification(title, body, () => focusMainWindow(host));
  });

  /* ===== 原生文件 / 目录选择器（本体在 picker.ts）=====
   * 只负责弹窗取路径；把路径写进授权账本由渲染端调 `fs_authorize_picked_paths` 完成
   * （账本归 sidecar 所有，主进程够不着）。见 picker.ts 的说明。 */
  on(IPC.picker.openFiles, (options) => {
    if (!options || typeof options !== "object") throw new Error("openFiles requires options");
    const { purpose, multiple } = options as Record<string, unknown>;
    if (typeof purpose !== "string") throw new Error("openFiles requires a string purpose");
    return openFiles({ purpose, multiple: multiple === true }, host.window());
  });
  on(IPC.picker.openDirectory, () => openDirectory(host.window()));
}
