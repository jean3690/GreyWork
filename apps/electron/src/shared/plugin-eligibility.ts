/**
 * 插件悬浮窗的**资格判定**（纯函数：脱开 Electron 也能单测）。
 *
 * 镜像 Rust 侧 `apps/desktop/src-tauri/src/plugin_window.rs::can_open_plugin_window`
 * 与 `greywork_host::plugin_market::declares_window_floating`：worker 包 + 带 render 循环 +
 * 显式声明 `window` + `requires` 含 `window.floating`。
 *
 * 渲染端本来只在 `window.floating` 已授权时才显示「弹出桌面」按钮；宿主这一层是纵深防御，
 * 所以宁可两侧都判。漂移风险由 `tests/plugin-eligibility.test.ts` 用真实形态的包结构钉住。
 */
interface PluginPackageLike {
  manifest?: {
    kind?: unknown;
    window?: { width?: unknown; height?: unknown } | null;
    runtime?: { render?: unknown } | null;
    requires?: unknown;
  } | null;
}

/** `requires` 里是否声明了 `window.floating`（字符串项，或带 `capability` 的对象项）。 */
export function declaresWindowFloating(requires: unknown): boolean {
  if (!Array.isArray(requires)) return false;
  return requires.some((item) => {
    if (item === "window.floating") return true;
    return !!item && typeof item === "object" && (item as { capability?: unknown }).capability === "window.floating";
  });
}

/** 该插件包是否有资格开悬浮窗。 */
export function canOpenPluginWindow(pluginPackage: unknown): boolean {
  if (!pluginPackage || typeof pluginPackage !== "object") return false;
  const manifest = (pluginPackage as PluginPackageLike).manifest;
  if (!manifest || typeof manifest !== "object") return false;
  if (manifest.kind !== "worker") return false;
  if (!manifest.window || typeof manifest.window !== "object") return false;
  const runtime = manifest.runtime;
  if (!runtime || typeof runtime !== "object" || runtime.render == null) return false;
  return declaresWindowFloating(manifest.requires);
}

/** 窗口尺寸钳制：manifest 校验已限 1–512，这里再夹一次（纵深防御）。 */
export function clampWindowSize(value: unknown): number {
  const num = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(512, Math.max(1, num));
}
