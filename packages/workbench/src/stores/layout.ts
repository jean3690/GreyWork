import { createJsonStorage } from "@greywork/core";
import { defineStore } from "pinia";
import { ref, watch } from "vue";

/**
 * 布局偏好：左侧栏是否折叠。
 *
 * **左栏折叠此前是 Shell 里的裸 ref**，每次启动都回到展开态 —— 一个「我习惯收起左栏」的
 * 用户每次开应用都要再按一次。右栏的宽度与折叠早就持久化了（`greywork.preview.panel`），
 * 这里只把左栏补上，沿用同一套 `createJsonStorage`，不引第三个持久化机制。
 *
 * 只存「偏好」不存「有效态」：窄屏下左栏是抽屉（打开/收起都是瞬态的），把它当偏好写回来
 * 会让用户在窄屏下开一次抽屉就把桌面的偏好改掉。有效态留在 Shell，窄屏时由它挡掉。
 *
 * 布局模式本身也**不落盘**（见 `lib/layout-modes.ts`）：它是两个面板可见性的函数，
 * 落盘只会制造第二份真源。
 */

interface LayoutPrefs {
  sidebarCollapsed: boolean;
}

function isPrefs(value: unknown): value is LayoutPrefs {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as Record<string, unknown>).sidebarCollapsed === "boolean";
}

const prefsStorage = createJsonStorage<LayoutPrefs>("greywork.layout", isPrefs);

export const useLayoutStore = defineStore("layout", () => {
  const sidebarCollapsed = ref(prefsStorage.read()?.sidebarCollapsed ?? false);
  // flush: "sync" 是有意的：默认的 "pre" 会把写入推迟到下一帧，于是「改了偏好 → 立刻
  // 卸载/关窗」会丢掉这次写入，而这里要存的只是一个布尔，同步写没有任何代价。
  watch(sidebarCollapsed, (value) => prefsStorage.write({ sidebarCollapsed: value }), { flush: "sync" });

  return { sidebarCollapsed };
});
