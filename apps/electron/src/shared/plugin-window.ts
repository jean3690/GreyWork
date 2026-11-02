/**
 * 插件悬浮窗的标签与形态（纯函数：不引 electron，主进程与单测共用）。
 *
 * 标签约定（渲染端按它反查插件，必须与 `PluginWindowView` 一致）：
 *
 *   plugin-window-<pluginId>          实例 1
 *   plugin-window-<pluginId>::<n>     实例 n（仅 `window.multiple` 为真时出现）
 *
 * 用 `::` 而不是 `-` 分隔：插件 id 本身允许 `-`（`demo.pet-shop`），
 * 用 `-` 会把 id 和后缀搅在一起，反查就会拿错包。
 */

/** 窗口标签前缀。 */
export const PLUGIN_WINDOW_LABEL_PREFIX = "plugin-window-";
/** 实例后缀分隔符（实例 1 不带后缀，保持与老版本标签完全一致）。 */
export const PLUGIN_WINDOW_INSTANCE_SEPARATOR = "::";
/** 同一插件最多同时开几扇窗：多开是为了「摆两只宠物」，不是开窗口管理器。 */
export const MAX_PLUGIN_WINDOW_INSTANCES = 4;

/** 形状上限（与 Rust `validate_package` 的 window 校验同口径）。 */
const TITLE_MAX_CHARS = 64;
const OPACITY_MIN = 0.2;
/** 标签拼接：实例 1 不带后缀，保持与 v1 的 `plugin-window-<id>` 完全一致。 */
export function pluginWindowLabel(pluginId: string, instance = 1): string {
  const safeInstance = Number.isInteger(instance) && instance > 1 ? Math.min(instance, MAX_PLUGIN_WINDOW_INSTANCES) : 1;
  return safeInstance === 1
    ? `${PLUGIN_WINDOW_LABEL_PREFIX}${pluginId}`
    : `${PLUGIN_WINDOW_LABEL_PREFIX}${pluginId}${PLUGIN_WINDOW_INSTANCE_SEPARATOR}${safeInstance}`;
}

/** 反解标签；不是插件悬浮窗（或 id 为空 / 实例号越界）返回 null。 */
export function parsePluginWindowLabel(label: string): { pluginId: string; instance: number } | null {
  if (typeof label !== "string" || !label.startsWith(PLUGIN_WINDOW_LABEL_PREFIX)) return null;
  const rest = label.slice(PLUGIN_WINDOW_LABEL_PREFIX.length);
  const [pluginId, rawInstance] = rest.split(PLUGIN_WINDOW_INSTANCE_SEPARATOR);
  if (!pluginId) return null;
  const instance = rawInstance === undefined ? 1 : Number(rawInstance);
  if (!Number.isInteger(instance) || instance < 1 || instance > MAX_PLUGIN_WINDOW_INSTANCES) return null;
  return { pluginId, instance };
}

export interface PluginWindowOptions {
  /** 窗口标题（任务栏 / 窗口列表里显示）。 */
  title: string;
  /** 初始是否置顶（运行时可从窗口内的「钉住」按钮切换）。 */
  alwaysOnTop: boolean;
  /** 不透明度 0.2-1。 */
  opacity: number;
  /** 是否允许多开。 */
  multiple: boolean;
}

interface PluginWindowDeclLike {
  title?: unknown;
  alwaysOnTop?: unknown;
  opacity?: unknown;
  multiple?: unknown;
}

/**
 * 从落盘包里读出窗口形态；manifest 安装期已经校验过，这里再夹一次（纵深防御，
 * 也保证手工改过 plugin.json 的插件不会开出全透明 / 空标题的窗）。
 */
export function pluginWindowOptions(pluginPackage: unknown, fallbackTitle: string): PluginWindowOptions {
  const manifest = (pluginPackage as { manifest?: { window?: PluginWindowDeclLike } } | null)?.manifest;
  const decl = manifest?.window ?? {};
  const name = (pluginPackage as { manifest?: { name?: unknown } } | null)?.manifest?.name;
  const rawTitle = typeof decl.title === "string" ? decl.title.trim() : "";
  // 控制字符（含 \x7f）：标题会进任务栏 / 窗口列表，换行与 ESC 序列都能伪造布局。
  const hasControl = (value: string): boolean => [...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  const title =
    rawTitle && rawTitle.length <= TITLE_MAX_CHARS && !hasControl(rawTitle)
      ? rawTitle
      : typeof name === "string" && name.trim()
        ? name.trim()
        : fallbackTitle;
  const opacity = typeof decl.opacity === "number" && Number.isFinite(decl.opacity) ? Math.min(1, Math.max(OPACITY_MIN, decl.opacity)) : 1;
  return {
    title,
    alwaysOnTop: decl.alwaysOnTop !== false,
    opacity,
    multiple: decl.multiple === true,
  };
}
