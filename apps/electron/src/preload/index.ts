/**
 * 渲染端能看到的唯一 Electron 面：`window.__GREYWORK_SHELL__`。
 *
 * 形状与 `@greywork/host-ipc` 的 `ElectronShellBridge`（`packages/host-ipc/src/shell.ts`）
 * 对齐 —— 门面据此把窗口控制 / 关闭守卫 / 剪贴板 / 应用信息抹平成与 Tauri 一致的签名，
 * 上层组件不感知运行时差异。
 *
 * `contextIsolation: true` 下渲染端拿不到 Node；所有能力都收敛到这几条白名单 IPC 通道，
 * 不暴露裸 `ipcRenderer`。
 *
 * 分组可以缺失：宿主门面对缺失的分组返回 null，渲染层据此自动降级而不是崩 —— 渐进迁移期
 * 靠这条保证「加了新分组但还没接线」不会把渲染端弄坏。
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

import { IPC, WINDOW_LABEL_ARG } from "../shared/channels";

/** 订阅主进程事件，返回同步解绑函数（与 Tauri 的 UnlistenFn 同型）。 */
function subscribe(channel: string, handler: (...args: unknown[]) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => handler(...args);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.off(channel, listener);
  };
}

/**
 * 本窗口的 label：主窗是 `main`，插件悬浮窗是 `plugin-window-<id>`（由主进程经
 * `additionalArguments` 传入）。渲染端 `PluginWindowView` 正是按它反查插件的。
 */
function windowLabel(): string {
  const prefix = `--${WINDOW_LABEL_ARG}`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "main";
}

contextBridge.exposeInMainWorld("__GREYWORK_SHELL__", {
  window: {
    label: windowLabel(),
    minimize: () => ipcRenderer.invoke(IPC.window.minimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.window.toggleMaximize),
    close: () => ipcRenderer.invoke(IPC.window.close),
    isMaximized: () => ipcRenderer.invoke(IPC.window.isMaximized),
    onResized: (handler: () => void) => subscribe(IPC.window.resized, () => handler()),
    onFocusChanged: (handler: (focused: boolean) => void) => subscribe(IPC.window.focus, (focused) => handler(focused === true)),
    syncUnsavedChanges: (unsaved: boolean) => ipcRenderer.invoke(IPC.closeGuard.syncUnsaved, unsaved),
    requestClose: () => ipcRenderer.invoke(IPC.closeGuard.requestClose),
    confirmExit: () => ipcRenderer.invoke(IPC.closeGuard.confirmExit),
    onCloseRequested: (handler: () => void) => subscribe(IPC.closeGuard.closeRequested, () => handler()),
    onExitRequested: (handler: () => void) => subscribe(IPC.closeGuard.exitRequested, () => handler()),
  },
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke(IPC.clipboard.writeText, text),
    readText: () => ipcRenderer.invoke(IPC.clipboard.readText),
    readImagePng: () => ipcRenderer.invoke(IPC.clipboard.readImagePng),
  },
  app: {
    version: () => ipcRenderer.invoke(IPC.app.version),
    homeDir: () => ipcRenderer.invoke(IPC.app.homeDir),
    openExternal: (url: string) => ipcRenderer.invoke(IPC.app.openExternal, url),
    revealPath: (path: string) => ipcRenderer.invoke(IPC.app.revealPath, path),
    openPath: (path: string) => ipcRenderer.invoke(IPC.app.openPath, path),
    // webUtils 在 preload（渲染进程侧）同步取 File 的磁盘路径 —— 拖放到预览面板用。
    pathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  tray: {
    available: () => ipcRenderer.invoke(IPC.tray.available),
    setCloseToTray: (enabled: boolean) => ipcRenderer.invoke(IPC.tray.setCloseToTray, enabled),
    setLabels: (labels: unknown) => ipcRenderer.invoke(IPC.tray.setLabels, labels),
    onNewChat: (handler: () => void) => subscribe(IPC.tray.newChat, () => handler()),
    onOpenSettings: (handler: () => void) => subscribe(IPC.tray.openSettings, () => handler()),
  },
  browser: {
    open: (url: string, rect: unknown) => ipcRenderer.invoke(IPC.browser.open, url, rect),
    setBounds: (rect: unknown) => ipcRenderer.invoke(IPC.browser.setBounds, rect),
    setVisible: (visible: boolean) => ipcRenderer.invoke(IPC.browser.setVisible, visible),
    navigate: (url: string) => ipcRenderer.invoke(IPC.browser.navigate, url),
    back: () => ipcRenderer.invoke(IPC.browser.back),
    forward: () => ipcRenderer.invoke(IPC.browser.forward),
    reload: () => ipcRenderer.invoke(IPC.browser.reload),
    stop: () => ipcRenderer.invoke(IPC.browser.stop),
    close: () => ipcRenderer.invoke(IPC.browser.close),
    onState: (handler: (state: unknown) => void) => subscribe(IPC.browser.state, (state) => handler(state)),
  },
  plugins: {
    notify: (request: unknown) => ipcRenderer.invoke(IPC.plugins.notify, request),
    openWindow: (pluginId: string) => ipcRenderer.invoke(IPC.plugins.openWindow, pluginId),
    closeWindow: (pluginId: string) => ipcRenderer.invoke(IPC.plugins.closeWindow, pluginId),
  },
  // 通用系统通知：服务端态把 `host://notify` 事件落到操作系统（Tauri 侧由 Rust 直接发，
  // 那个事件根本不会到渲染端）。文案原样呈现，不加归属前缀 —— 插件通知走上面的 plugins。
  notify: {
    system: (title: string, body: string) => ipcRenderer.invoke(IPC.notify.system, title, body),
  },
  // 只负责弹窗取路径。**授权不在主进程**：路径授权账本归 sidecar（服务端）所有，主进程
  // 够不着，所以由渲染端拿到路径后调 `fs_authorize_picked_paths` 声明 —— `host-ipc` 的
  // `hostPicker()` 已把这一步包进返回值，调用方仍是「选完就能用」。
  picker: {
    openFiles: (options: { purpose: "media" | "workspace"; multiple: boolean }) =>
      ipcRenderer.invoke(IPC.picker.openFiles, options),
    openDirectory: () => ipcRenderer.invoke(IPC.picker.openDirectory),
  },
});
