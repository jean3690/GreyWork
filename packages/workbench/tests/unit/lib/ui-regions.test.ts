import { describe, expect, it } from "vitest";
import { partitionActivityTabs, resolveActiveTab, sortUiRegions } from "@/lib/ui-regions";
import type { UiRegionContribution } from "@/plugins/types";

/**
 * uiRegions 展示层纯函数：排序（order 升序、缺省排后、稳定）、
 * activityPanel 分区（overflow 只进「更多」）、激活回退
 * （任意贡献有效则保留 → 失效回退首个常驻 → 常驻空为 null）。
 */

const dummy = { render: () => null };

function region(id: string, extra: Partial<UiRegionContribution> = {}): UiRegionContribution {
  return { region: "activityPanel", id, title: id, component: dummy, ...extra };
}

describe("sortUiRegions", () => {
  it("按 order 升序", () => {
    const sorted = sortUiRegions([region("a", { order: 3 }), region("b", { order: 1 }), region("c", { order: 2 })]);
    expect(sorted.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("缺省 order 排在显式 order 之后", () => {
    const sorted = sortUiRegions([region("a"), region("b", { order: 1 }), region("c")]);
    expect(sorted.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("order 相等或缺省时保持注册序（稳定排序）", () => {
    const list = [region("a", { order: 1 }), region("b"), region("c", { order: 1 }), region("d")];
    const sorted = sortUiRegions(list);
    expect(sorted.map((r) => r.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("空列表返回空数组，不原地修改入参", () => {
    const list: UiRegionContribution[] = [region("a", { order: 2 }), region("b", { order: 1 })];
    const snapshot = [...list];
    expect(sortUiRegions([])).toEqual([]);
    sortUiRegions(list);
    expect(list).toEqual(snapshot);
  });
});

describe("partitionActivityTabs", () => {
  it("overflow 贡献只进 overflow 分区，各分区保持入参顺序", () => {
    const list = [region("a", { order: 2 }), region("b", { overflow: true }), region("c", { order: 1 })];
    const { pinned, overflow } = partitionActivityTabs(list);
    expect(pinned.map((r) => r.id)).toEqual(["a", "c"]);
    expect(overflow.map((r) => r.id)).toEqual(["b"]);
  });

  it("无 overflow 贡献时 overflow 分区为空", () => {
    const { pinned, overflow } = partitionActivityTabs([region("a"), region("b")]);
    expect(pinned).toHaveLength(2);
    expect(overflow).toEqual([]);
  });
});

describe("resolveActiveTab", () => {
  const all = ["a", "b", "c"];
  const pinned = ["a", "b"];

  it("activeId 是任意贡献（含「更多」里的 overflow）则原样保留", () => {
    expect(resolveActiveTab(all, pinned, "b")).toBe("b");
    expect(resolveActiveTab(all, pinned, "c")).toBe("c");
  });

  it("activeId 失效（插件被停）回退首个常驻", () => {
    expect(resolveActiveTab(all, pinned, "gone")).toBe("a");
  });

  it("activeId 为 null 取首个常驻；常驻为空返回 null", () => {
    expect(resolveActiveTab(all, pinned, null)).toBe("a");
    expect(resolveActiveTab([], [], null)).toBeNull();
    expect(resolveActiveTab([], [], "anything")).toBeNull();
  });
});
