/**
 * 外观的落地与订阅（事件通知模式）。
 *
 * 权威状态在 Pinia（stores/settings.ts 的 colorMode），落地分两步：
 *  1. 解析 `system` → 实际明暗，写到 documentElement 的 data-* 上（CSS 靠它取色，
 *     首帧内联脚本也写同一组属性）；
 *  2. 在 window 上广播 `APPEARANCE_EVENT`。
 *
 * 为什么用事件而不是让消费方自己盯 DOM：第三方视图（Mermaid / Univer）拿不到 Vue
 * 的响应式，之前各自起一个 MutationObserver 去盯 data-theme —— 一次外观切换要派发
 * N 次 DOM 回调，而且「谁在盯、退订没有」散在各组件里。改成事件后只有一个广播点，
 * 订阅就是 addEventListener，退订就是 removeEventListener。
 *
 * data-* 依然是取色真源（CSS 变量选择器靠它），事件只是变化通知，两者不冲突。
 */
import { onScopeDispose, ref, type Ref } from "vue";
import type { ColorMode } from "../stores/settings";

/** 解析后的实际明暗（不含 system）。 */
export type ResolvedTheme = "light" | "dark";

/** 外观变化事件名。任何消费方都该订阅它，而不是去观察 data-theme。 */
export const APPEARANCE_EVENT = "greywork:appearance" as const;

/** 广播出去的外观快照。 */
export interface AppearanceDetail {
  /** data-palette：greywork / night-blue / night-green / github / fox。 */
  palette: string;
  /** 解析后的实际明暗。 */
  theme: ResolvedTheme;
  /** data-fontSize：small / medium / large。 */
  fontSize: string;
}

/** 请求应用一份外观（colorMode 未解析，system 在这里展开）。 */
export interface AppearanceInput {
  palette: string;
  colorMode: ColorMode;
  fontSize: string;
}

declare global {
  interface WindowEventMap {
    [APPEARANCE_EVENT]: CustomEvent<AppearanceDetail>;
  }
}

/** 上一次广播出去的外观；只用于去重，null 表示还没广播过。 */
let current: AppearanceDetail | null = null;

/** `system` 展开成实际明暗。 */
export function resolveTheme(mode: ColorMode): ResolvedTheme {
  if (mode !== "system") return mode;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function readTheme(): ResolvedTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function isDarkMode(): boolean {
  return readTheme() === "dark";
}

/**
 * 外观的唯一落地点：写 data-* + 广播。
 *
 * 所有想改外观的地方（设置控件点击、Shell 跟随系统、首帧 hydrate）都必须走这里，
 * 否则 DOM 变了而消费方收不到通知，视图就停在旧外观上。
 *
 * 属性值每次都写（幂等，且首帧可能已被内联脚本写过）；事件只在外观真的变了才发 ——
 * 设置页一次点击会让 store 和 Shell 各调一次，不去重就是两遍重渲。
 */
export function applyAppearance(input: AppearanceInput): void {
  // 没有 document 就整个跳过：连取色真源都不存在，广播也无从谈起（node 单测即此环境，
  // 那里的 window 只是 localStorage 桩，没有 dispatchEvent）。
  if (typeof document === "undefined") return;
  const theme = resolveTheme(input.colorMode);
  const root = document.documentElement;
  root.dataset.palette = input.palette;
  root.dataset.theme = theme;
  root.dataset.fontSize = input.fontSize;

  if (current && current.palette === input.palette && current.theme === theme && current.fontSize === input.fontSize) return;
  current = { palette: input.palette, theme, fontSize: input.fontSize };
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: current }));
}

/**
 * 订阅实际明暗变化，返回退订函数。
 *
 * 只在明暗真的翻转时回调：换配色、改字号也广播，但那些不影响 Mermaid / Univer 的
 * 明暗，跟着重渲是白花钱。
 */
export function watchTheme(listener: (theme: ResolvedTheme) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  let seen = readTheme();
  const handler = (event: WindowEventMap[typeof APPEARANCE_EVENT]): void => {
    if (event.detail.theme === seen) return;
    seen = event.detail.theme;
    listener(event.detail.theme);
  };
  window.addEventListener(APPEARANCE_EVENT, handler);
  return () => window.removeEventListener(APPEARANCE_EVENT, handler);
}

/** 组件内订阅：随作用域自动退订。 */
export function useTheme(): Ref<ResolvedTheme> {
  const theme = ref<ResolvedTheme>(readTheme());
  const stop = watchTheme((next) => {
    theme.value = next;
  });
  onScopeDispose(stop);
  return theme;
}
