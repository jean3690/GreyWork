/**
 * 插件脱窗悬浮窗（对齐 Tauri 壳 `plugin_window.rs`）。
 *
 * 安全模型与 Tauri 侧一致：**插件代码永远拿不到窗口句柄**。窗口的建/关都由宿主完成，且先按
 * 落盘包（`<dataDir>/plugins/<id>/plugin.json`）复核资格（判定逻辑在
 * `shared/plugin-eligibility.ts`，与 Rust 侧同口径）。渲染端本来只在 `window.floating` 已授权
 * 时才显示「弹出桌面」按钮，这里是纵深防御。
 *
 * 窗口内容 = 同一份 SPA 的隐藏路由 `#/plugin-window`；渲染端按窗口 label
 * （`plugin-window-<id>`）反查插件，所以 label 必须经 `additionalArguments` 喂给 preload。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { BrowserWindow } from "electron";

import { WINDOW_LABEL_ARG } from "../shared/channels";
import { canOpenPluginWindow, clampWindowSize } from "../shared/plugin-eligibility";
import { pluginsRoot, preloadPath } from "./paths";

/** 窗口 label 前缀（渲染端 `PluginWindowView` 按它反查插件）。 */
export const PLUGIN_WINDOW_LABEL_PREFIX = "plugin-window-";

/** 已开的悬浮窗：label → 窗口。幂等开窗与关窗都查它。 */
const windows = new Map<string, BrowserWindow>();

interface PluginPackageShape {
  manifest?: { id?: unknown; name?: unknown; window?: { width?: unknown; height?: unknown } | null } | null;
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

/**
 * 打开（或前置）插件的悬浮窗；幂等 —— 已存在则置顶并聚焦。
 * `port` 是 sidecar 端口，窗口据此从同一源载入 SPA。
 */
export function openPluginWindow(pluginId: string, port: number): void {
  const label = `${PLUGIN_WINDOW_LABEL_PREFIX}${pluginId}`;
  const already = windows.get(label);
  if (already && !already.isDestroyed()) {
    already.show();
    already.focus();
    return;
  }

  const pluginPackage = readPluginPackage(pluginId);
  if (!canOpenPluginWindow(pluginPackage)) {
    console.warn(`[plugin-window] ${pluginId} 不具备悬浮窗资格（需 worker + render + window 声明 + window.floating）`);
    return;
  }
  const declaration = pluginPackage?.manifest?.window ?? {};
  const title = typeof pluginPackage?.manifest?.name === "string" ? pluginPackage.manifest.name : pluginId;

  const win = new BrowserWindow({
    width: clampWindowSize(declaration.width),
    height: clampWindowSize(declaration.height),
    minWidth: 64,
    minHeight: 64,
    title,
    // 悬浮宠物形态：透明底、无装饰、置顶、不占任务栏、禁缩放（对齐 Tauri 的 builder）。
    frame: false,
    transparent: true,
    alwaysOnTop: true,
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
  win.on("closed", () => windows.delete(label));
  void win.loadURL(`http://127.0.0.1:${port}/#/plugin-window`).catch(() => undefined);
}

/** 关闭插件的悬浮窗（卸载 / 停用插件时渲染端调用）；不存在即静默成功。 */
export function closePluginWindow(pluginId: string): void {
  const label = `${PLUGIN_WINDOW_LABEL_PREFIX}${pluginId}`;
  const win = windows.get(label);
  windows.delete(label);
  if (win && !win.isDestroyed()) win.destroy();
}
