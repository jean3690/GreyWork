import { createJsonStorage } from "@greywork/core";
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { modeOf, visibilityOf, type LayoutMode } from "../lib/layout-modes";
import { usePreviewStore } from "./preview";

/**
 * 布局偏好与模式。
 *
 * - **左栏折叠此前是 Shell 里的裸 ref**，每次启动都回到展开态 —— 一个「我习惯收起左栏」的
 *   用户每次开应用都要再按一次。右栏的宽度与折叠早就持久化了（`greywork.preview.panel`），
 *   这里只把左栏补上，沿用同一套 `createJsonStorage`，不引第三个持久化机制。
 * - **模式是推导的，不落盘**（见 `lib/layout-modes.ts`）：它是两个面板可见性的函数，
 *   落盘只会多出「模式显示三栏、实际只剩一个面板」这种坏状态。`mode` / `applyMode`
 *   读同一份 `visibilityOf` —— 一处实现。
 *
 * 只存「偏好」不存「有效态」：窄屏下左栏是抽屉（开关都是瞬态的），把它当偏好写回来
 * 会让用户在窄屏开一次抽屉就把桌面偏好改掉。有效态留在 Shell，由它决定何时回写。
 */

interface LayoutPrefs {
  sidebarCollapsed: boolean;
}

function isPrefs(value: unknown): value is LayoutPrefs {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.sidebarCollapsed === "boolean";
}

const prefsStorage = createJsonStorage<LayoutPrefs>("greywork.layout", isPrefs);

export const useLayoutStore = defineStore("layout", () => {
  const preview = usePreviewStore();

  const stored = prefsStorage.read();
  const sidebarCollapsed = ref(stored?.sidebarCollapsed ?? false);
  // flush: "sync" 是有意的：默认的 "pre" 会把写入推迟到下一帧，于是「改了偏好 → 立刻
  // 卸载/关窗」会丢掉这次写入，而这里要存的只是布尔，同步写没有任何代价。
  watch(sidebarCollapsed, () => prefsStorage.write({ sidebarCollapsed: sidebarCollapsed.value }), { flush: "sync" });

  /**
   * 当前模式。窄屏下右栏不渲染，那时它不算「在场」—— 否则指示器会点亮一个不存在的面板。
   * 两种面板状态组合不出模式时返回 null，指示器便不点亮任何一档。
   */
  const mode = computed<LayoutMode | null>(() =>
    modeOf({ sidebar: !sidebarCollapsed.value, preview: preview.available && !preview.collapsed }),
  );

  /** 把两个面板一起拨到目标布局。Ctrl+1~4 与标题栏的布局指示器共用这一处实现。 */
  function applyMode(next: LayoutMode): void {
    const target = visibilityOf(next);
    sidebarCollapsed.value = !target.sidebar;
    // 窄屏不渲染右栏，别去展开一个不存在的东西
    if (preview.available) preview.setCollapsed(!target.preview);
  }

  return { sidebarCollapsed, mode, applyMode };
});
