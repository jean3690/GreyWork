/**
 * 宿主「窗口壳」门面：桌面窗口控制（最小化 / 最大化 / 关闭）、关闭—退出守卫与窗口事件。
 *
 * 桌面后端是 **Electron**（`window.__GREYWORK_SHELL__`，由 `apps/electron/src/preload` 注入）：
 * 窗口生命周期归 Electron 主进程，**不经 Rust server** —— server 没有窗口，收口直接走 bridge。
 *
 * 无窗口宿主（server 自托管 / browser-preview）：`hostWindow()` / `closeGuardHost()` 返回 `null`，
 * 调用方据此不渲染控制键、不接线守卫。
 *
 * 这是继 `invoke` / `listen` 之后，渲染端对宿主的第三类门面。Tauri 壳的对应实现随
 * 「删 Tauri」一并移除（历史见 git）。*/
import type { UnlistenFn } from "./events";
import { invoke } from "./invoke";
import { runtimeMode } from "./runtime";

/** 主窗口 label；Electron 主窗默认同名（历史上与 Tauri 的 `main` 对齐）。 */
export const MAIN_WINDOW_LABEL = "main";

/** 跨后端一致的窗口控制面（Titlebar 用）。 */
export interface HostWindow {
  /** 窗口标识；插件悬浮窗据此反查包（`plugin-window-<id>`）。 */
  readonly label: string;
  /**
   * 宿主平台（Electron 的 `process.platform`：`darwin` / `win32` / `linux`）。
   *
   * 窗口圆角在三端不是同一套机制：macOS / Windows 交给系统，Linux 上 Electron 30 的
   * `roundedCorners` 还不生效，要由渲染端把窗口变透明后自己裁（见 window-frame.ts）。
   */
  readonly platform: string;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /**
   * 显示窗口。Electron 由主进程的 `ready-to-show` 托管，此调用为空操作
   * （历史上 Tauri 侧首帧后调用，`visible:false` 起手防白屏闪烁）。
   */
  show(): Promise<void>;
  /** 缩放因子（物理像素 → 逻辑像素）。Electron 用 devicePixelRatio。 */
  scaleFactor(): Promise<number>;
  /** 开始拖动窗口。Electron 下走 CSS `-webkit-app-region`，此调用为空操作。 */
  startDragging(): Promise<void>;
  /** 尺寸变化（最大化状态回灌）。 */
  onResized(handler: () => void): Promise<UnlistenFn>;
  /** 焦点变化（内嵌浏览器覆盖层据此让位）。 */
  onFocusChanged(handler: (focused: boolean) => void): Promise<UnlistenFn>;
}

/** 关闭—退出守卫面：窗口生命周期收口，走 Electron 主进程。 */
export interface CloseGuardHost {
  /** 把「当前是否有未保存改动」同步给宿主，宿主据此决定要不要拦退出。 */
  syncUnsavedChanges(unsaved: boolean): Promise<void>;
  /** 请宿主按「关闭到托盘」偏好收口（隐藏或真关）。 */
  requestClose(): Promise<void>;
  /** 真正退出应用（守卫放行后调用）。 */
  confirmExit(): Promise<void>;
  /**
   * 订阅「点 X 关窗」。事件抵达时关闭动作**已被宿主拦下**，`handler` 只负责决定收口
   * （Electron 主进程监听拦截事件）。
   */
  onCloseRequested(handler: () => void): Promise<UnlistenFn>;
  /** 订阅「托盘退出 / Cmd+Q」这条绕过关窗的退出路径。 */
  onExitRequested(handler: () => void): Promise<UnlistenFn>;
}

/* ===== Electron bridge 形状（preload 经 contextBridge 注入）===== */

interface ElectronShellBridge {
  window: {
    label: string;
    platform: string;
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    onResized(handler: () => void): UnlistenFn;
    onFocusChanged(handler: (focused: boolean) => void): UnlistenFn;
    syncUnsavedChanges(unsaved: boolean): Promise<void>;
    requestClose(): Promise<void>;
    confirmExit(): Promise<void>;
    onCloseRequested(handler: () => void): UnlistenFn;
    onExitRequested(handler: () => void): UnlistenFn;
  };
  clipboard: {
    writeText(text: string): Promise<void>;
    readText(): Promise<string>;
    readImagePng(): Promise<Uint8Array | null>;
  };
  app: {
    version(): Promise<string | null>;
    homeDir(): Promise<string | null>;
    openExternal(url: string): Promise<void>;
    /** 在系统文件管理器中揭示路径。 */
    revealPath(path: string): Promise<void>;
    /** 用系统默认程序打开路径。 */
    openPath(path: string): Promise<void>;
    pathForFile(file: File): string;
  };
  /** 选择器 / 插件 / 托盘 / 内嵌浏览器分组在 Electron 壳里**可选**：壳可能尚未实现（渐进迁移中），
   *  门面对缺失的分组返回 null，调用方据此降级而不是崩。 */
  picker?: {
    openFiles(options: { purpose: "media" | "workspace"; multiple: boolean }): Promise<string[]>;
    openDirectory(): Promise<string | null>;
  };
  plugins?: {
    notify(request: { pluginId: string; title: string; body: string }): Promise<{ title: string; body: string }>;
    openWindow(pluginId: string): Promise<void>;
    closeWindow(pluginId: string): Promise<void>;
  };
  notify?: {
    system(title: string, body: string): Promise<void>;
  };
  tray?: {
    available(): Promise<boolean>;
    setCloseToTray(enabled: boolean): Promise<void>;
    setLabels(labels: TrayLabels): Promise<void>;
    onNewChat(handler: () => void): UnlistenFn;
    onOpenSettings(handler: () => void): UnlistenFn;
  };
  browser?: {
    open(url: string, rect: HostBrowserRect): Promise<void>;
    setBounds(rect: HostBrowserRect): Promise<void>;
    setVisible(visible: boolean): Promise<void>;
    navigate(url: string): Promise<void>;
    back(): Promise<void>;
    forward(): Promise<void>;
    reload(): Promise<void>;
    stop(): Promise<void>;
    close(): Promise<void>;
    onState(handler: (state: HostBrowserState) => void): UnlistenFn;
  };
}

/** 取 Electron bridge（存在即 Electron 壳），否则 null。用 `in` 窄化，不内联断言形状。 */
function electronBridge(): ElectronShellBridge | null {
  if (typeof window === "undefined") return null;
  if (!("__GREYWORK_SHELL__" in window)) return null;
  const bridge = (window as Window & { __GREYWORK_SHELL__?: unknown }).__GREYWORK_SHELL__;
  return bridge && typeof bridge === "object" && "window" in bridge ? (bridge as ElectronShellBridge) : null;
}

/** 是否有可控宿主窗口（Electron 壳）；纯服务端 / 浏览器为 false。 */
export function hasWindowControls(): boolean {
  return electronBridge() !== null;
}

/**
 * 是否有「原生桌面壳」（Electron）。
 *
 * **桌面专属命令（22 条 `desktop_only`）的守卫该用它**，不要用 `hasHostCommands()`：
 * Electron 下 `hasHostCommands()` 为 true（server 态）→ 真去 invoke → server 403。
 * 本谓词在 Electron 下为真、纯服务端/浏览器为 false。
 */
export function hasNativeShell(): boolean {
  return hasWindowControls();
}

/** 当前宿主窗口控制面；无窗口宿主返回 null。 */
export function hostWindow(): HostWindow | null {
  const electron = electronBridge();
  if (electron) {
    const w = electron.window;
    return {
      label: w.label,
      platform: w.platform,
      minimize: () => w.minimize(),
      toggleMaximize: () => w.toggleMaximize(),
      close: () => w.close(),
      isMaximized: () => w.isMaximized(),
      show: () => Promise.resolve(), // 主进程 ready-to-show 已显示，渲染端无需再管
      scaleFactor: () => Promise.resolve(window.devicePixelRatio || 1),
      startDragging: () => Promise.resolve(), // CSS app-region 托管，见 main.ts 注入的样式
      onResized: (handler) => Promise.resolve(w.onResized(handler)),
      onFocusChanged: (handler) => Promise.resolve(w.onFocusChanged(handler)),
    };
  }
  return null;
}

/** 关闭—退出守卫面；无窗口宿主返回 null。 */
export function closeGuardHost(): CloseGuardHost | null {
  const electron = electronBridge();
  if (electron) {
    const w = electron.window;
    return {
      syncUnsavedChanges: (unsaved) => w.syncUnsavedChanges(unsaved),
      requestClose: () => w.requestClose(),
      confirmExit: () => w.confirmExit(),
      onCloseRequested: (handler) => Promise.resolve(w.onCloseRequested(handler)),
      onExitRequested: (handler) => Promise.resolve(w.onExitRequested(handler)),
    };
  }
  return null;
}

/* ===== 内嵌浏览器门面 ===== *
 * 预览面板的「浏览器」标签需要一块原生子视图叠在渲染层之上：
 * Electron 主进程挂一个 WebContentsView（apps/electron/src/main/browser-view.ts），走 bridge。
 * 无宿主（纯 server / 浏览器预览）返回 null，调用方据此给占位文案。*/

/** 槽位矩形：窗口客户区坐标，逻辑像素（CSS px）。 */
export interface HostBrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 子视图实时状态快照（字段名跨后端对齐 camelCase）。 */
export interface HostBrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** 内嵌浏览器控制面：打开 / 定位 / 显隐 / 导航 / 状态订阅。 */
export interface HostBrowser {
  open(url: string, rect: HostBrowserRect): Promise<void>;
  setBounds(rect: HostBrowserRect): Promise<void>;
  setVisible(visible: boolean): Promise<void>;
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
  onState(handler: (state: HostBrowserState) => void): Promise<UnlistenFn>;
}

/** 当前宿主的内嵌浏览器控制面；无宿主返回 null。 */
export function hostBrowser(): HostBrowser | null {
  const electron = electronBridge();
  if (electron?.browser) {
    const b = electron.browser;
    return {
      open: (url, rect) => b.open(url, rect),
      setBounds: (rect) => b.setBounds(rect),
      setVisible: (visible) => b.setVisible(visible),
      navigate: (url) => b.navigate(url),
      back: () => b.back(),
      forward: () => b.forward(),
      reload: () => b.reload(),
      stop: () => b.stop(),
      close: () => b.close(),
      onState: (handler) => Promise.resolve(b.onState(handler)),
    };
  }
  return null;
}

/* ===== 剪贴板门面 ===== *
 * 按运行时选可靠的那条路：
 * - Electron（Chromium）：主进程 `clipboard` 模块可靠（经 bridge），不碰 Web API 的权限提示。
 * - 浏览器态：真浏览器上 `navigator.clipboard` 可靠。
 * 两条分支各自在自己的环境里都可靠，不会走到对方那行。*/

export interface HostClipboard {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
  /** 系统剪贴板里的图片，PNG 字节；无图 / 不支持返回 null。 */
  readImagePng(): Promise<Uint8Array | null>;
}

export function hostClipboard(): HostClipboard {
  const electron = electronBridge();
  if (electron) {
    const c = electron.clipboard;
    return {
      writeText: (text) => c.writeText(text),
      readText: () => c.readText(),
      readImagePng: () => c.readImagePng(),
    };
  }
  return {
    // 浏览器态：真浏览器的 navigator.clipboard 可靠（见上）。
    // eslint-disable-next-line no-restricted-properties
    writeText: (text) => navigator.clipboard.writeText(text),
    // eslint-disable-next-line no-restricted-properties
    readText: () => navigator.clipboard.readText(),
    readImagePng: readClipboardImageViaWebApi,
  };
}

/** 浏览器态经 `navigator.clipboard.read()` 取图片；无图或不支持返回 null。 */
async function readClipboardImageViaWebApi(): Promise<Uint8Array | null> {
  // 浏览器态是唯一可靠用 Web Clipboard API 的运行时（见上文分支说明）。
  // eslint-disable-next-line no-restricted-properties
  if (typeof navigator === "undefined" || !navigator.clipboard?.read) return null;
  try {
    // eslint-disable-next-line no-restricted-properties
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      const blob = await item.getType(type);
      return new Uint8Array(await blob.arrayBuffer());
    }
    return null;
  } catch {
    return null;
  }
}

/* ===== 应用门面（版本 / 主目录 / 外部链接）===== *
 * 只有「有原生壳」的运行时才有这些：Electron 返回非空，纯服务端自托管 / 浏览器预览
 * 返回 null —— 调用方据此回落（版本改读 /api/health 的 hostVersion，外链开新标签页）。*/

export interface HostApp {
  /** 应用版本号。 */
  version(): Promise<string | null>;
  /** 用户主目录；无原生宿主为 null。 */
  homeDir(): Promise<string | null>;
  /** 用系统默认浏览器打开外部链接。 */
  openExternal(url: string): Promise<void>;
  /** 在系统文件管理器中揭示磁盘路径（交付物卡片「在文件夹中打开」）。 */
  revealPath(path: string): Promise<void>;
  /** 用系统默认程序打开磁盘路径（预览面板「用系统应用打开」）。 */
  openPath(path: string): Promise<void>;
  /** 取被拖入的 File 的磁盘绝对路径（Electron 经 webUtils）；无路径 / 其他宿主返回 null。 */
  pathForDroppedFile(file: File): string | null;
}

/** 当前原生宿主应用面；纯服务端 / 浏览器态返回 null。 */
export function hostApp(): HostApp | null {
  const electron = electronBridge();
  if (electron) {
    const a = electron.app;
    return {
      version: () => a.version(),
      homeDir: () => a.homeDir(),
      openExternal: (url) => a.openExternal(url),
      revealPath: (path) => a.revealPath(path),
      openPath: (path) => a.openPath(path),
      pathForDroppedFile: (file) => a.pathForFile(file) || null,
    };
  }
  return null;
}

/* ===== 原生拖放门面 ===== *
 * Electron / 浏览器：OS 拖放以标准 HTML5 drop 抵达 DOM（磁盘路径经
 * `hostApp().pathForDroppedFile`），由调用方的 HTML5 路径处理，本门面恒返回 null。
 * 保留这个恒空的 seam：它是「拖放走宿主事件还是走 DOM」这条分叉的文档化出口。*/

export interface HostDragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  /** 物理像素坐标（窗口客户区）。 */
  position: { x: number; y: number };
  /** 落下的磁盘路径（enter / over / leave 为空数组）。 */
  paths: readonly string[];
}

export interface HostDragDrop {
  onDragDrop(handler: (payload: HostDragDropPayload) => void): Promise<UnlistenFn>;
}

/** 当前宿主的原生拖放面；恒为 null（OS 拖放以 HTML5 drop 抵达 DOM，调用方走 HTML5 路径）。 */
export function hostDragDrop(): HostDragDrop | null {
  return null;
}

/**
 * 把一批路径声明为**用户拖放产生的**，纳入宿主的工作区授权账本。
 *
 * **Electron / 自托管服务端**下渲染端从 `hostApp().pathForDroppedFile` 拿到的是绝对路径，
 * 而宿主并不知道用户拖过什么 —— 不声明的话，随后的 `fs_read_*` 会以「路径未获用户授权」
 * 拒绝（授权面只认 `GREYWORK_WORKSPACE_ROOTS` 与这个账本）。
 * **目录被忽略**：拖了个文件夹进来不该让整批授权一起失败。
 *
 * 失败只记日志、不抛：授权是「读得到」的前提，让后续读取照常报自己的错，比在这里吞掉
 * 整次拖放更好排查。服务端侧这条命令受 `GREYWORK_TRUSTED_HOST` 守，不可信部署下会 403。
 */
export async function authorizeDroppedPaths(paths: readonly string[]): Promise<void> {
  // 只有「命令经服务端」的宿主需要显式声明（浏览器预览态拿不到磁盘路径，也到不了这里）。
  if (runtimeMode() !== "server" || paths.length === 0) return;
  try {
    await invoke("fs_authorize_drop_paths", { paths: [...paths] });
  } catch (error) {
    console.warn("[host] 拖放路径授权失败（后续读取会自行报错）：", error);
  }
}

/* ===== 原生文件/目录选择门面 ===== *
 * 桌面壳的系统选择器；纯服务端 / 浏览器态返回 null，调用方回落 input / webkitdirectory。
 *
 * 对话框在主进程、授权账本在 sidecar —— 这里替调用方把「弹窗 → fs_authorize_picked_paths
 * 声明」两步串起来，调用方拿到即可读。*/

export interface HostPicker {
  /** 打开文件选择器；取消 / 失败返回空数组。 */
  pickFiles(options: { purpose: "media" | "workspace"; multiple: boolean }): Promise<string[]>;
  /** 打开目录选择器；取消返回 null。 */
  pickWorkspaceFolder(): Promise<string | null>;
}

/**
 * 把「系统选择器选中的路径」声明给宿主，返回规范路径（服务端态才需要）。
 *
 * 失败时回落原值并告警：让后续 `fs_read_*` 报出「路径未获用户授权」这个真实原因，比在这里
 * 悄悄丢掉用户刚选的目录更好排查。
 */
async function authorizePickedPaths(paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0 || runtimeMode() !== "server") return [...paths];
  try {
    const authorized = await invoke<string[]>("fs_authorize_picked_paths", { paths: [...paths] });
    return Array.isArray(authorized) && authorized.length === paths.length ? authorized : [...paths];
  } catch (error) {
    console.warn("[host] 选择路径授权失败（后续读取会自行报错）：", error);
    return [...paths];
  }
}

/** 当前宿主的选择器面；纯服务端 / 浏览器态返回 null。 */
export function hostPicker(): HostPicker | null {
  const electron = electronBridge();
  if (electron?.picker) {
    const p = electron.picker;
    return {
      pickFiles: async (options) => authorizePickedPaths(await p.openFiles({ purpose: options.purpose, multiple: options.multiple })),
      pickWorkspaceFolder: async () => {
        const picked = await p.openDirectory();
        if (!picked) return null;
        return (await authorizePickedPaths([picked]))[0] ?? picked;
      },
    };
  }
  return null;
}

/* ===== 通用系统通知面 ===== *
 * 语义上属**宿主能力**（把一条通知交给操作系统），与 `hostPlugins().notify` 的区别是
 * **不加归属前缀** —— 那条是插件能力，前缀由宿主加、插件伪造不了。*/

export interface HostNotify {
  /** 发一条系统通知；`title` / `body` 原样呈现。 */
  send(title: string, body: string): Promise<void>;
}

/**
 * 当前宿主的系统通知面；无原生壳返回 null（纯服务端自托管 Web 没有通知面）。
 * 服务端宿主把 `host://notify` 事件推给渲染端，由 `@greywork/workbench` 的
 * `useHostNotifications` 接上并转调本门面。
 */
export function hostNotify(): HostNotify | null {
  const electron = electronBridge();
  const bridge = electron?.notify;
  if (bridge) return { send: (title, body) => bridge.system(title, body) };
  return null;
}

/* ===== 插件宿主面（系统通知 + 插件悬浮窗）===== *
 * **仅桌面端**能力：纯服务端 / 浏览器态返回 null，调用方据此 no-op 或给出降级文案。*/

export interface HostPlugins {
  /** 发系统通知；返回宿主加了 `[pluginId] ` 归属前缀的最终文案。 */
  notify(request: { pluginId: string; title: string; body: string }): Promise<{ title: string; body: string }>;
  /** 打开插件脱窗悬浮窗（幂等）。 */
  openWindow(pluginId: string): Promise<void>;
  /** 关闭插件悬浮窗（不存在或已关静默成功）。 */
  closeWindow(pluginId: string): Promise<void>;
}

/** 当前宿主的插件面；无原生桌面壳返回 null。 */
export function hostPlugins(): HostPlugins | null {
  const electron = electronBridge();
  if (electron?.plugins) {
    const p = electron.plugins;
    return {
      notify: (request) => p.notify(request),
      openWindow: (pluginId) => p.openWindow(pluginId),
      closeWindow: (pluginId) => p.closeWindow(pluginId),
    };
  }
  return null;
}

/* ===== 系统托盘门面 ===== *
 * 托盘本体在宿主侧（apps/electron/src/main/tray.ts）。宿主不持有语言，菜单文案由渲染端
 * 整份推送；菜单点击经事件广播回渲染端转应用内动作。 */

/** 托盘菜单文案（宿主原生菜单不认 i18n，切语言时整份重推）。 */
export interface TrayLabels {
  toggleWindow: string;
  newChat: string;
  settings: string;
  quit: string;
  /** 首次隐藏到托盘时的一次性系统通知正文。 */
  hiddenHint: string;
}

export interface TrayEventHandlers {
  newChat: () => void;
  openSettings: () => void;
}

export interface HostTray {
  /** 当前系统 / 宿主是否真有可用托盘（Linux 缺 AppIndicator、创建失败均为 false）。 */
  available(): Promise<boolean>;
  /** 同步「关闭到托盘」偏好；宿主据此决定点 X 是隐藏还是真退。 */
  setCloseToTray(enabled: boolean): Promise<void>;
  /** 整份推送菜单文案。 */
  setLabels(labels: TrayLabels): Promise<void>;
  /** 订阅托盘菜单的「新建对话 / 打开设置」动作。 */
  onEvent(handlers: TrayEventHandlers): Promise<UnlistenFn>;
}

/** 当前宿主托盘面；无窗口宿主返回 null。 */
export function hostTray(): HostTray | null {
  const electron = electronBridge();
  if (electron?.tray) {
    const t = electron.tray;
    return {
      available: () => t.available(),
      setCloseToTray: (enabled) => t.setCloseToTray(enabled),
      setLabels: (labels) => t.setLabels(labels),
      onEvent: (handlers) => {
        const offNew = t.onNewChat(handlers.newChat);
        const offSettings = t.onOpenSettings(handlers.openSettings);
        return Promise.resolve(() => {
          offNew();
          offSettings();
        });
      },
    };
  }
  return null;
}
