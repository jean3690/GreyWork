import { item, separator, type ContextMenuItem } from "@/lib/context-menu";
import type { ContextMenuContribution, PluginContextTarget } from "./types";

/**
 * 把已启用插件的右键条目拼到宿主条目后面。
 *
 * - 没有匹配条目时返回空数组：调用方直接展开，不会多出空的分隔线与分组标题；
 * - 分组用 `label` 标明归属，避免「这个『打开』到底是宿主的还是插件的」；
 * - 条目只做导航（`open(modeId)` 由各处传 router.push），与命令面板同一取舍：
 *   右键菜单同样可能在目标页 worker 未装载时被点开。
 */
export function pluginContextMenuItems(
  contributions: readonly ContextMenuContribution[],
  target: PluginContextTarget,
  open: (modeId: string) => void,
): ContextMenuItem[] {
  const matched = contributions.filter((entry) => entry.targets.includes(target));
  if (!matched.length) return [];
  return [
    separator(),
    { kind: "label", label: "插件" },
    ...matched.map((entry) => item(entry.label, () => open(entry.modeId), { icon: "magic" })),
  ];
}
