import { createIdFactory, createJsonStorage } from "@greywork/core";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { DEFAULT_PREVIEW_PANEL_PX, MAX_PREVIEW_TABS, clampPreviewWidth, shouldAutoCollapse } from "../lib/layout";
import { basename, kindOfPath, type ViewerKind } from "../lib/viewer";

const nextTabId = createIdFactory("pv");

/**
 * 一个预览 tab。
 *
 * **内容不在这里**：viewer 自己按 path + source 读。二进制产物（xlsx/pdf）动辄数 MB，
 * 塞进 pinia 响应式状态会被深度代理并随快照序列化，代价与收益完全不成比例。
 * 就地更新靠 `revision` 自增通知 —— viewer watch 它重新读一次，路径不变也能刷新。
 */

/**
 * 内容来源。
 * - `vfs`：内存虚拟文件系统（管线产物、种子文件），路径是相对路径
 * - `disk`：真实磁盘（工作区文件树），路径是绝对路径
 * - `web`：抓取到的网页正文，路径是归一化后的 URL（内容在 lib/web-fetch 的缓存里）
 *
 * 做成显式字段而不是「按路径是否以 / 开头猜」：Windows 的绝对路径不以 / 开头，
 * 而猜错的代价是读不到文件或读错文件。
 */
export type PreviewSource = "vfs" | "disk" | "web";

export interface PreviewTab {
  id: string;
  /** `vfs` 为 VFS 相对路径，`disk` 为磁盘绝对路径。 */
  path: string;
  name: string;
  kind: ViewerKind;
  source: PreviewSource;
  /** artifact:updated 每次到达自增；viewer 据此重载。 */
  revision: number;
  /**
   * 磁盘孪生路径：`vfs` 产物由 deliverArtifact 落盘后带回，预览据此提供
   * 「用系统应用打开」。`disk` 源的 path 本身就是磁盘路径，此项恒为空。
   */
  diskPath?: string;
}

interface PreviewPrefs {
  collapsed: boolean;
  widthPx: number;
  /** 上次拖拽提交时面板占 [会话区 + 右栏] 行的比例；窗口缩放时按它重算宽度。 */
  ratio: number | null;
}

function isPrefs(value: unknown): value is PreviewPrefs {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.collapsed === "boolean" &&
    typeof record.widthPx === "number" &&
    (record.ratio === undefined || record.ratio === null || typeof record.ratio === "number")
  );
}

const prefsStorage = createJsonStorage<PreviewPrefs>("greywork.preview.panel", isPrefs);

/**
 * 右栏预览面板状态：tab 列表 + 折叠 + 宽度偏好。
 *
 * 事件订阅**不在 store 里**：bus 是模块级单例，而 store 每个 pinia 实例都会重建一次，
 * 在 setup 里 on() 会让每个测试都往同一个 bus 上再挂一份监听（跨用例泄漏）。
 * 订阅交给 `usePreviewBridge()` 在组件作用域内做，随组件卸载解绑。
 */
export const usePreviewStore = defineStore("preview", () => {
  const tabs = ref<PreviewTab[]>([]);
  const activeId = ref<string | null>(null);
  const savedPrefs = prefsStorage.read();
  /** 默认折叠：没有产物时右栏纯属占地方，第一个 tab 打开时自动展开。 */
  const collapsed = ref(savedPrefs?.collapsed ?? true);
  const widthPx = ref(clampPreviewWidth(savedPrefs?.widthPx ?? DEFAULT_PREVIEW_PANEL_PX));
  const ratio = ref<number | null>(savedPrefs?.ratio ?? null);
  /**
   * 伙伴面板（工作区栏）当前占用的宽度：由 Shell 回灌，0 = 伙伴折叠。
   * 面板间不互相读 store（那会形成 setup 时的实例依赖），只经 Shell 单向转发。
   */
  const reservedPx = ref(0);
  /** [会话区 + 右栏] 行的实测宽度，由 Shell 的 ResizeObserver 回灌；0 = 未测量。 */
  const availableWidth = ref(0);
  /**
   * 当前视口是否渲染右栏（窄屏不渲染）。
   *
   * 由 Shell 的视口同步回灌，是这个阈值的**唯一来源** —— Titlebar 的开关按钮也读它。
   * 之前按钮用 Tailwind 的 `sm:`（640px）控制显隐、而 Shell 用 768px 判断是否渲染面板，
   * 两个阈值各写一处，结果 640–768px 之间按钮可见但面板不存在，点了没反应。
   */
  const available = ref(true);

  const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeId.value) ?? null);
  /** 生效宽度：折叠为 0，否则按实测容器宽度与伙伴预留收敛偏好值。 */
  const effectiveWidthPx = computed(() => (collapsed.value ? 0 : clampPreviewWidth(widthPx.value, availableWidth.value, reservedPx.value)));

  function persist(): void {
    prefsStorage.write({ collapsed: collapsed.value, widthPx: widthPx.value, ratio: ratio.value });
  }

  /**
   * 打开（或聚焦）一个路径的预览；返回 tab id。
   * 同路径不重复开（artifact 卡片被连点多次、或树里反复点同一文件都只聚焦）。
   * `basename` 用 `/` 切，磁盘路径的名字在 Windows 上可能带 `\` —— 由调用方传 name 兜住。
   */
  function open(path: string, name?: string, source: PreviewSource = "vfs", kind?: ViewerKind): string {
    const existing = tabs.value.find((tab) => tab.path === path && tab.source === source);
    if (existing) {
      activeId.value = existing.id;
      if (collapsed.value) setCollapsed(false);
      return existing.id;
    }
    const tab: PreviewTab = {
      id: nextTabId(),
      path,
      name: name ?? basename(path),
      // 网页正文的 URL 没有可用扩展名，调用方显式给 kind；其余仍按扩展名推断。
      kind: kind ?? kindOfPath(path),
      source,
      revision: 0,
    };
    tabs.value = [...tabs.value, tab];
    // 超上限先丢最旧的非激活 tab；激活 tab 永不被自动关掉（用户正看着它）。
    while (tabs.value.length > MAX_PREVIEW_TABS) {
      const victim = tabs.value.find((candidate) => candidate.id !== tab.id);
      if (!victim) break;
      tabs.value = tabs.value.filter((candidate) => candidate.id !== victim.id);
    }
    activeId.value = tab.id;
    if (collapsed.value) setCollapsed(false);
    return tab.id;
  }

  /** 就地重载某路径的 tab（产物被追加/覆盖时）；未打开则不做任何事，不偷偷弹面板。 */
  function reload(path: string): void {
    tabs.value = tabs.value.map((tab) => (tab.path === path ? { ...tab, revision: tab.revision + 1 } : tab));
  }

  /**
   * 给已打开的 tab 记上磁盘孪生路径（产物落盘后到达）。
   *
   * 不复用 `open()`：它命中同路径就走早退分支，新参数会被静默丢掉 —— 而
   * `attachDiskPath` 恰恰要处理「tab 已经开着、落盘路径才回来」这种时序。
   * 已有值不覆盖（首次落盘的那份才是卡片认的路径），也不动 revision：
   * 这只是给工具栏按钮定位，内容没变，不该触发 viewer 重载。
   */
  function attachDiskPath(path: string, diskPath: string): void {
    if (!diskPath) return;
    tabs.value = tabs.value.map((tab) => (tab.path === path && !tab.diskPath ? { ...tab, diskPath } : tab));
  }

  function activate(id: string): void {
    if (tabs.value.some((tab) => tab.id === id)) activeId.value = id;
  }

  /**
   * 把 tab 拖拽重排到目标下标（tab 条拖放排序用）。
   *
   * **不改 activeId**：拖拽只是整理顺序，不该抢走用户正看着的 tab —— 与各编辑器
   * 的通行约定一致。越界下标收敛到有效区间；id 不存在时是 no-op。
   */
  function moveTab(id: string, toIndex: number): void {
    const from = tabs.value.findIndex((tab) => tab.id === id);
    if (from === -1) return;
    const target = Math.max(0, Math.min(toIndex, tabs.value.length - 1));
    if (target === from) return;
    const next = [...tabs.value];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    tabs.value = next;
  }

  /**
   * 关闭 tab；关掉的是激活项时把焦点交给右邻（没有则左邻），空了则折叠面板。
   * 注意这里**不负责问用户** —— 该不该在关之前确认由界面决定。
   */
  function close(id: string): void {
    const index = tabs.value.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    const remaining = tabs.value.filter((tab) => tab.id !== id);
    tabs.value = remaining;
    if (activeId.value !== id) return;
    const next = remaining[index] ?? remaining[index - 1] ?? null;
    activeId.value = next?.id ?? null;
    if (!next) setCollapsed(true);
  }

  function closeAll(): void {
    tabs.value = [];
    activeId.value = null;
    setCollapsed(true);
  }

  function setCollapsed(value: boolean): void {
    collapsed.value = value;
    persist();
  }

  function toggle(): void {
    setCollapsed(!collapsed.value);
  }

  /** 拖拽提交宽度；`commit` 为 false 时只更新视图不写盘（拖拽过程中每帧都写盘毫无意义）。 */
  function setWidth(px: number, commit = true): void {
    widthPx.value = clampPreviewWidth(px, availableWidth.value, reservedPx.value);
    if (!commit) return;
    // 记下占容器比例：窗口缩放时按比例重算，px 才不会被「固定宽聊胜于无」的旧策略拉偏。
    if (availableWidth.value > 0) ratio.value = widthPx.value / availableWidth.value;
    persist();
  }

  /**
   * 容器实测宽度回灌。
   * 若有记录的比例（上次拖拽提交时定下），先按 比例 × 新宽 重算 px 并收敛到
   * MIN/MAX，再窄到装不下时自动折叠（用户仍可手动展开，只是会很挤）。
   */
  function setAvailableWidth(px: number): void {
    if (px > 0 && ratio.value && ratio.value > 0 && !collapsed.value) {
      widthPx.value = clampPreviewWidth(Math.round(ratio.value * px), px, reservedPx.value);
    }
    availableWidth.value = px;
    if (!collapsed.value && shouldAutoCollapse(px, reservedPx.value)) setCollapsed(true);
  }

  /** 伙伴面板（工作区栏）当前占用宽度回灌；改它只影响生效宽度，不动偏好。 */
  function setReserved(px: number): void {
    reservedPx.value = px;
  }

  /**
   * 视口是否支持右栏。**不动折叠偏好**：窄屏时面板整个不渲染，没有覆盖聊天区的问题，
   * 没必要强制折叠；不改偏好，切回宽屏就能恢复用户离开前的状态。
   */
  function setAvailable(value: boolean): void {
    available.value = value;
  }

  return {
    tabs,
    activeId,
    activeTab,
    collapsed,
    widthPx,
    ratio,
    reservedPx,
    availableWidth,
    available,
    effectiveWidthPx,
    open,
    reload,
    attachDiskPath,
    activate,
    moveTab,
    close,
    closeAll,
    setCollapsed,
    toggle,
    setWidth,
    setAvailableWidth,
    setReserved,
    setAvailable,
  };
});
