import { describe, expect, it, vi } from "vitest";
import { pluginContextMenuItems } from "@/plugins/context-menu";
import type { ContextMenuContribution } from "@/plugins/types";

/**
 * 右键里的插件条目：
 *  - 没有匹配区域时返回空数组（调用方直接展开，不会多出空分隔线 / 空分组）；
 *  - 有匹配时是「分隔线 + 分组标题 + 条目」，点条目只做导航（open(modeId)）。
 */

const contribution = (
  id: string,
  label: string,
  targets: ContextMenuContribution["targets"],
  modeId = "demo-page",
): ContextMenuContribution => ({ id, label, targets, modeId, pluginId: "demo.plugin" });

describe("pluginContextMenuItems", () => {
  it("无匹配条目时什么都不加（宿主的菜单保持原样）", () => {
    expect(pluginContextMenuItems([], "fileTree", vi.fn())).toEqual([]);
    expect(pluginContextMenuItems([contribution("a", "打开", ["preview"])], "fileTree", vi.fn())).toEqual([]);
  });

  it("有匹配时返回 分隔线 + 分组标题 + 条目", () => {
    const items = pluginContextMenuItems([contribution("a", "用插件打开", ["fileTree"])], "fileTree", vi.fn());
    expect(items.map((entry) => entry.kind)).toEqual(["separator", "label", "item"]);
    expect(items[1]).toMatchObject({ label: "插件" });
    expect(items[2]).toMatchObject({ label: "用插件打开", icon: "magic" });
  });

  it("点条目只把目标页交给 open（不在菜单里跑插件代码）", () => {
    const open = vi.fn();
    const items = pluginContextMenuItems([contribution("a", "打开", ["conversation"], "demo-pet")], "conversation", open);
    const entry = items[2];
    if (entry.kind !== "item") throw new Error("expected item");
    entry.onSelect();
    expect(open).toHaveBeenCalledWith("demo-pet");
  });

  it("同一区域的多条贡献按注册顺序排列", () => {
    const items = pluginContextMenuItems(
      [contribution("a", "第一条", ["preview"]), contribution("b", "第二条", ["preview"])],
      "preview",
      vi.fn(),
    );
    expect(items.filter((entry) => entry.kind === "item").map((entry) => (entry as { label: string }).label)).toEqual(["第一条", "第二条"]);
  });
});
