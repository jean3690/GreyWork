import type { UiRegionContribution } from "../plugins/types";

/**
 * uiRegions 展示层纯函数：排序 / 分区 / 激活回退。
 *
 * 与 Vue/pinia 无关，宿主组件在 computed 里调用；单测直接覆盖。
 */

/**
 * 同 region 内排序：`order` 升序，缺省视作排在有 order 的贡献之后；
 * 相等或缺省时保持注册序（Array.prototype.sort 的稳定排序兜底）。
 */
export function sortUiRegions<T extends UiRegionContribution>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
}

/**
 * activityPanel 分区：常驻标签 / 「更多」折叠项。
 * 输入应先经 sortUiRegions —— 两个分区各自保持该全局顺序。
 */
export function partitionActivityTabs<T extends UiRegionContribution>(
  list: readonly T[],
): {
  pinned: T[];
  overflow: T[];
} {
  const pinned: T[] = [];
  const overflow: T[] = [];
  for (const contribution of list) {
    (contribution.overflow === true ? overflow : pinned).push(contribution);
  }
  return { pinned, overflow };
}

/**
 * 激活页签解析：activeId 仍是任意贡献（常驻或「更多」里的 overflow）则原样保留；
 * 失效（对应插件被停用）回退首个常驻页签；常驻为空返回 null。
 * 宿主显示层据此自愈，store 不做任何校验、保持哑。
 */
export function resolveActiveTab(allIds: readonly string[], pinnedIds: readonly string[], activeId: string | null): string | null {
  if (activeId !== null && allIds.includes(activeId)) return activeId;
  return pinnedIds[0] ?? null;
}
