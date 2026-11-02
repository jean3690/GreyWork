/**
 * 插件脱窗悬浮窗（对齐 Tauri 壳 `plugin_window.rs`）。
 *
 * 安全模型与 Tauri 侧一致：**插件代码永远拿不到窗口句柄**。窗口的建/关都由宿主完成，且先按
 * 落盘包（`<dataDir>/plugins/<id>/plugin.json`）复核资格（判定逻辑在
 * `shared/plugin-eligibility.ts`，与 Rust 侧同口径）。渲染端本来只在 `window.floating` 已授权
 * 时才显示「弹出桌面」按钮，这里是纵深防御。
 *
 * 窗口内容 = 同一份 SPA 的隐藏路由 `#/plugin-window`；渲染端按窗口 label
 * （`plugin-window-<id>[::<n>]`）反查插件，所以 label 必须经 `additionalArguments` 喂给 preload。
 *
 * v2（标题 / 置顶 / 不透明度 / 位置持久化 / 多开）全部是**形态**，不改变资格判定：
 * - 形态来自 manifest 的 `window` 声明（安装期已校验，这里再夹一次）；
 * - 几何按 label 记账到 `plugin-window-bounds.json`，开窗时用 `placeWindow` 拉回可见区；
 * - 置顶可在窗口内切换 —— 走 IPC，作用于**调用方自己那扇窗**（多开时不会开错）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BrowserWindow, app, screen, type WebContents } from "electron";

import { WINDOW_LABEL_ARG } from "../shared/channels";
import { canOpenPluginWindow, clampWindowSize } from "../shared/plugin-eligibility";
import {
  MAX_PLUGIN_WINDOW_INSTANCES,
  PLUGIN_WINDOW_LABEL_PREFIX,
  parsePluginWindowLabel,
  pluginWindowLabel,
  pluginWindowOptions,
} from "../shared/plugin-window";
import { placeWindow } from "../shared/window-placement";
import { guardNavigation } from "./navigation";
import { pluginsRoot, preloadPath } from "./paths";

/** 窗口 label 前缀（渲染端 `PluginWindowView` 按它反查插件）。保留导出给既有引用。 */
export { PLUGIN_WINDOW_LABEL_PREFIX };

/** 已开的悬浮窗：label → 窗口。多开时每个实例一条。 */
const windows = new Map<string, BrowserWindow>();

interface PluginPackageShape {
  manifest?: {
    id?: unknown;
    name?: unknown;
    window?: {
      width?: unknown;
      height?: unknown;
      title?: unknown;
      alwaysOnTop?: unknown;
      opacity?: unknown;
      multiple?: unknown;
    } | null;
  } | null;
}

/** 读某插件落盘包；失败 / 目录名不安全返回 null。 */
function readPluginPackage(pluginId: string): PluginPackageShape | null {
  // 防目录穿越：只允许安全字符（与 Rust `validate_dir_key` 同口径）。
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pluginId)) return null;
  try {
    const raw = readFileSync(path.join(pluginsRoot(), pluginId, "plugin.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as PluginPackageShape) : null;
  } catch {
    return null;
  }
}

// ---------- 几何持久化 ----------

interface SavedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const boundsFile = (): string => path.join(app.getPath("userData"), "plugin-window-bounds.json");
let boundsCache: Record<string, SavedBounds> | null = null;
const saveTimers = new Map<string, NodeJS.Timeout>();

function loadBounds(): Record<string, SavedBounds> {
  if (boundsCache) return boundsCache;
  const parsed: unknown = (() => {
    try {
      return JSON.parse(readFileSync(boundsFile(), "utf8"));
    } catch {
      return null;
    }
  })();
  const result: Record<string, SavedBounds> = {};
  if (parsed && typeof parsed === "object") {
    for (const [label, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const bounds = value as Record<string, unknown>;
      if ([bounds.x, bounds.y, bounds.width, bounds.height].every((item) => typeof item === "number")) {
        result[label] = {
          x: bounds.x as number,
          y: bounds.y as number,
          width: bounds.width as number,
          height: bounds.height as number,
        };
      }
    }
  }
  boundsCache = result;
  return result;
}

function persistBounds(): void {
  try {
    writeFileSync(boundsFile(), JSON.stringify(loadBounds()));
  } catch {
    // 落盘失败不影响运行：下次开窗退化为按 manifest 尺寸居中。
  }
}

/** 记一扇窗的当前几何（内存 + 去抖落盘）。 */
function rememberBounds(label: string, win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const { x, y, width, height } = win.getBounds();
  loadBounds()[label] = { x, y, width, height };
  clearTimeout(saveTimers.get(label));
  // 拖拽期间高频触发：去抖 400ms（与主窗 window-state 同节奏）。
  saveTimers.set(
    label,
    setTimeout(() => {
      saveTimers.delete(label);
      persistBounds();
    }, 400),
  );
}

/** 关窗前必须同步落盘：窗口销毁后 `getBounds()` 已经拿不到几何了。 */
function flushBounds(label: string, win: BrowserWindow): void {
  clearTimeout(saveTimers.get(label));
  saveTimers.delete(label);
  if (!win.isDestroyed()) {
    const { x, y, width, height } = win.getBounds();
    loadBounds()[label] = { x, y, width, height };
  }
  persistBounds();
}

// ---------- 窗口生命周期 ----------

/** 同插件的存活实例（按实例号升序）。 */
function liveInstances(pluginId: string): Array<{ label: string; instance: number; win: BrowserWindow }> {
  const found: Array<{ label: string; instance: number; win: BrowserWindow }> = [];
  for (const [label, win] of windows) {
    const parsed = parsePluginWindowLabel(label);
    if (parsed?.pluginId === pluginId && !win.isDestroyed()) {
      found.push({ label, instance: parsed.instance, win });
    }
  }
  return found.sort((left, right) => left.instance - right.instance);
}

function focusWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.show();
  win.focus();
}

/**
 * 打开插件的悬浮窗。
 * - `multiple` 为假（缺省）：已开则前置并聚焦，行为与 v1 一致；
 * - `multiple` 为真：找最小的空实例号再开一扇，满 4 扇就前置最后一扇。
 *
 * `origin` 是渲染端当前 origin（sidecar 同源或 Vite dev server），窗口据此从同一源载入 SPA；
 * 它用默认 session，主窗为该 origin 注入的 `gw_session` cookie 自动共享。
 */
export function openPluginWindow(pluginId: string, origin: string): void {
  const pluginPackage = readPluginPackage(pluginId);
  if (!canOpenPluginWindow(pluginPackage)) {
    console.warn(`[plugin-window] ${pluginId} 不具备悬浮窗资格（需 worker + render + window 声明 + window.floating）`);
    return;
  }
  const options = pluginWindowOptions(pluginPackage, pluginId);
  const live = liveInstances(pluginId);
  if (live.length > 0 && !options.multiple) {
    focusWindow(live[0].win);
    return;
  }
  let instance = 1;
  if (options.multiple) {
    const used = new Set(live.map((entry) => entry.instance));
    while (used.has(instance) && instance <= MAX_PLUGIN_WINDOW_INSTANCES) instance += 1;
    if (instance > MAX_PLUGIN_WINDOW_INSTANCES) {
      focusWindow(live[live.length - 1].win);
      return;
    }
  }

  const label = pluginWindowLabel(pluginId, instance);
  const declaration = pluginPackage?.manifest?.window ?? {};
  const saved = loadBounds()[label];
  // 显示器拓扑可能变过（拔屏 / 改分辨率）：越界坐标拉回工作区，与主窗同一套修正。
  const placed = placeWindow(
    {
      x: saved?.x,
      y: saved?.y,
      width: clampWindowSize(saved?.width ?? declaration.width),
      height: clampWindowSize(saved?.height ?? declaration.height),
      maximized: false,
    },
    screen.getAllDisplays().map((display) => display.workArea),
  );

  const win = new BrowserWindow({
    x: placed.x,
    y: placed.y,
    width: placed.width,
    height: placed.height,
    minWidth: 64,
    minHeight: 64,
    title: options.title,
    // 悬浮宠物形态：透明底、无装饰、默认置顶、不占任务栏、禁缩放（对齐 Tauri 的 builder）。
    frame: false,
    transparent: true,
    alwaysOnTop: options.alwaysOnTop,
    opacity: options.opacity,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: true,
    webPreferences: {
      preload: preloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      // 与主窗一致：preload 要能 require 相对模块（shared/channels）。
      sandbox: false,
      // 渲染端靠这个参数得知自己是哪个窗口（PluginWindowView 按 label 反查插件）。
      additionalArguments: [`--${WINDOW_LABEL_ARG}${label}`],
    },
  });
  windows.set(label, win);
  win.on("moved", () => rememberBounds(label, win));
  win.on("close", () => flushBounds(label, win));
  win.on("closed", () => windows.delete(label));
  guardNavigation(win.webContents, origin);
  void win.loadURL(`${origin}/#/plugin-window`).catch(() => undefined);
}

/** 关闭插件的全部悬浮窗（卸载 / 停用插件时渲染端调用）；不存在即静默成功。 */
export function closePluginWindow(pluginId: string): void {
  for (const { label, win } of liveInstances(pluginId)) {
    windows.delete(label);
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * 切换**调用方自己那扇窗**的置顶（悬浮窗内的「钉住」按钮）。
 *
 * 按 webContents 反查而不是按 pluginId：多开时同一个插件有多个窗口，
 * 用 id 查表会切换错对象。返回切换后的实际状态（渲染端据它更新按钮）。
 */
export function setAlwaysOnTopForWebContents(contents: WebContents, next: boolean): boolean {
  const win = BrowserWindow.fromWebContents(contents);
  if (!win || win.isDestroyed()) return false;
  win.setAlwaysOnTop(next);
  return win.isAlwaysOnTop();
}
