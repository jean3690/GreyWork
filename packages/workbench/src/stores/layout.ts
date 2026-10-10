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
 *   落盘只会多出「模式显示三栏、实际只剩一个面板」这种坏状态。指示器读 `mode`，
 *   点击走 `applyMode` —— 一处实现，标题栏与 Ctrl+1~4 共用。
 * - **极简模式是一条独立的持久化轴，不进 layout-modes 的可见性函数。** split/chat/document/focus
 *   这四个档的不变量是「档位 = 两个面板可见性的函数」，而极简模式替换的是**外壳 chrome**
 *   （顶栏 + 侧栏内容），不是单靠面板可见性能表达的 —— 硬塞进去会破坏那个不变量。所以它单独
 *   落成 `minimal` 布尔，与 `sidebarCollapsed` 共用同一套 storage。
 *
 * 只存「偏好」不存「有效态」：窄屏下左栏是抽屉（开关都是瞬态的），把它当偏好写回来
 * 会让用户在窄屏开一次抽屉就把桌面偏好改掉。有效态留在 Shell，由它决定何时回写。
 */

interface LayoutPrefs {
  sidebarCollapsed: boolean;
  /** 极简模式偏好。旧存档没有这个字段（读回 undefined → 默认 false），故可选。 */
  minimal?: boolean;
}

function isPrefs(value: unknown): value is LayoutPrefs {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.sidebarCollapsed !== "boolean") return false;
  // minimal 是后加的字段：缺失合法（旧存档），存在则必须是布尔。
  if (record.minimal !== undefined && typeof record.minimal !== "boolean") return false;
  return true;
}

const prefsStorage = createJsonStorage<LayoutPrefs>("greywork.layout", isPrefs);

export const useLayoutStore = defineStore("layout", () => {
  const preview = usePreviewStore();

  const stored = prefsStorage.read();
  const sidebarCollapsed = ref(stored?.sidebarCollapsed ?? false);
  const minimal = ref(stored?.minimal ?? false);
  // flush: "sync" 是有意的：默认的 "pre" 会把写入推迟到下一帧，于是「改了偏好 → 立刻
  // 卸载/关窗」会丢掉这次写入，而这里要存的只是布尔，同步写没有任何代价。
  watch([sidebarCollapsed, minimal], () => prefsStorage.write({ sidebarCollapsed: sidebarCollapsed.value, minimal: minimal.value }), {
    flush: "sync",
  });

  /**
   * 当前模式。窄屏下右栏不渲染，那时它不算「在场」—— 否则指示器会点亮一个不存在的面板。
   * 两种面板状态组合不出模式时返回 null，指示器便不点亮任何一档。
   *
   * 极简模式下面板布局档概念不成立（右栏 / 工作区 / 活动带整体不渲染），一律返回 null，
   * 避免给出一个「看起来是三栏、实际只是极简外壳」的误导档位。
   */
  const mode = computed<LayoutMode | null>(() =>
    minimal.value ? null : modeOf({ sidebar: !sidebarCollapsed.value, preview: preview.available && !preview.collapsed }),
  );

  /** 把两个面板一起拨到目标布局。标题栏点击与 Ctrl+1~4 都走这里。 */
  function applyMode(next: LayoutMode): void {
    const target = visibilityOf(next);
    sidebarCollapsed.value = !target.sidebar;
    // 窄屏不渲染右栏，别去展开一个不存在的东西
    if (preview.available) preview.setCollapsed(!target.preview);
  }

  /** 进出极简模式。单独一个 setter，调用点不直接写 ref（后续要加副作用时只有一处）。 */
  function setMinimal(next: boolean): void {
    minimal.value = next;
  }

  return { sidebarCollapsed, minimal, mode, applyMode, setMinimal };
});
