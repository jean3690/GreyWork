/**
 * 主进程 ↔ preload 的 IPC 通道名，**单一真源**。
 *
 * preload 经 `contextBridge` 只暴露一份白名单 API（`window.__GREYWORK_SHELL__`），形状与
 * `@greywork/host-ipc` 的 `ElectronShellBridge` 对齐；两侧都从这里取通道名，避免字符串漂移。
 *
 * 命名约定 `shell:<域>:<动作>`：`shell:` 前缀把宿主 IPC 与渲染层的业务事件（`browser:state`、
 * `tray:new-chat` 之类）区分开。
 */
export const IPC = {
  window: {
    minimize: "shell:window:minimize",
    toggleMaximize: "shell:window:toggle-maximize",
    close: "shell:window:close",
    isMaximized: "shell:window:is-maximized",
    /** 主进程 → 渲染端：尺寸 / 最大化状态变化（Titlebar 据此切图标）。 */
    resized: "shell:window:resized",
    /** 主进程 → 渲染端：窗口焦点变化（内嵌浏览器覆盖层据此让位）。 */
    focus: "shell:window:focus",
  },
  closeGuard: {
    syncUnsaved: "shell:close-guard:sync-unsaved",
    requestClose: "shell:close-guard:request-close",
    confirmExit: "shell:close-guard:confirm-exit",
    /** 主进程 → 渲染端：点 X 关窗已被拦下，渲染端决定收口（保存 / 放弃）。 */
    closeRequested: "shell:close-guard:close-requested",
    /** 主进程 → 渲染端：托盘退出 / Cmd+Q 这条绕过关窗的退出路径。 */
    exitRequested: "shell:close-guard:exit-requested",
  },
  clipboard: {
    writeText: "shell:clipboard:write-text",
    readText: "shell:clipboard:read-text",
    readImagePng: "shell:clipboard:read-image-png",
  },
  app: {
    version: "shell:app:version",
    homeDir: "shell:app:home-dir",
    openExternal: "shell:app:open-external",
    revealPath: "shell:app:reveal-path",
    openPath: "shell:app:open-path",
  },
  tray: {
    available: "shell:tray:available",
    setCloseToTray: "shell:tray:set-close-to-tray",
    setLabels: "shell:tray:set-labels",
    /** 主进程 → 渲染端：托盘菜单「新建对话」。 */
    newChat: "shell:tray:new-chat",
    /** 主进程 → 渲染端：托盘菜单「设置」。 */
    openSettings: "shell:tray:open-settings",
  },
  browser: {
    open: "shell:browser:open",
    setBounds: "shell:browser:set-bounds",
    setVisible: "shell:browser:set-visible",
    navigate: "shell:browser:navigate",
    back: "shell:browser:back",
    forward: "shell:browser:forward",
    reload: "shell:browser:reload",
    stop: "shell:browser:stop",
    close: "shell:browser:close",
    /** 主进程 → 渲染端：子视图实时状态（url / 标题 / loading / 前进后退可用性）。 */
    state: "shell:browser:state",
  },
  plugins: {
    notify: "shell:plugins:notify",
    openWindow: "shell:plugins:open-window",
    closeWindow: "shell:plugins:close-window",
  },
  /** 通用系统通知（不带插件归属前缀）；插件通知走 `plugins.notify`。 */
  notify: {
    system: "shell:notify:system",
  },
  picker: {
    openFiles: "shell:picker:open-files",
    openDirectory: "shell:picker:open-directory",
  },
} as const;

/**
 * 把宿主窗口 label 传给 preload 的启动参数前缀。
 *
 * preload 跑在渲染进程里，没有 API 直接问「我是哪个窗口」；Electron 的标准做法是主进程建窗时
 * 用 `webPreferences.additionalArguments` 塞一个 `--gw-window-label=<label>`，preload 从
 * `process.argv` 里读。主窗是 `main`，插件悬浮窗是 `plugin-window-<id>` —— 渲染端的
 * `PluginWindowView` 正是靠这个 label 反查插件。
 */
export const WINDOW_LABEL_ARG = "gw-window-label=";

/** 窗口焦点事件载荷。 */
export type WindowFocusPayload = boolean;
