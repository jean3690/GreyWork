/**
 * 预览面板 store：tab 去重、关闭后的焦点转移、空了自动折叠、宽度持久化。
 * 这些是用户每天点几十次的行为，错一条就是「点了没反应」或「面板自己跳出来」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
};
vi.stubGlobal("localStorage", localStorageStub);
vi.stubGlobal("window", { localStorage: localStorageStub });

import { DEFAULT_PREVIEW_PANEL_PX, MAX_PREVIEW_TABS, MIN_CONTENT_PX, MIN_PREVIEW_PANEL_PX } from "@/lib/layout";
import { hasSheetDraft, stashSheetDraft } from "@/lib/sheet-draft";
import { usePreviewStore } from "@/stores/preview";
import type { IWorkbookData } from "@univerjs/core";

/** 草稿只被登记处的键值语义用到，内容是什么无关紧要。 */
function stash(tabId: string): void {
  stashSheetDraft(tabId, {
    base: { id: "b" } as IWorkbookData,
    current: { id: "c" } as IWorkbookData,
    source: new Uint8Array(),
  });
}

beforeEach(() => {
  storage.clear();
  setActivePinia(createPinia());
});

describe("open", () => {
  it("首次打开：新增 tab、聚焦它、并把面板展开（默认是折叠的）", () => {
    const preview = usePreviewStore();
    expect(preview.collapsed).toBe(true);

    const id = preview.open("reports/a.md");
    expect(preview.tabs).toHaveLength(1);
    expect(preview.activeId).toBe(id);
    expect(preview.activeTab?.kind).toBe("md");
    expect(preview.activeTab?.name).toBe("a.md");
    expect(preview.collapsed).toBe(false);
  });

  it("同路径重复打开只聚焦，不新增 tab", () => {
    const preview = usePreviewStore();
    const first = preview.open("reports/a.md");
    preview.open("data/b.csv");
    const again = preview.open("reports/a.md");

    expect(again).toBe(first);
    expect(preview.tabs).toHaveLength(2);
    expect(preview.activeId).toBe(first);
  });

  it("显式 name 优先于路径末段（产物名可能与文件名不同）", () => {
    const preview = usePreviewStore();
    preview.open("artifacts/x1.xlsx", "客流统计");
    expect(preview.activeTab?.name).toBe("客流统计");
  });

  it("超过上限丢最旧的 tab，但绝不丢刚打开的那个", () => {
    const preview = usePreviewStore();
    for (let i = 0; i < MAX_PREVIEW_TABS + 3; i += 1) preview.open(`f${i}.md`);

    expect(preview.tabs).toHaveLength(MAX_PREVIEW_TABS);
    expect(preview.activeTab?.path).toBe(`f${MAX_PREVIEW_TABS + 2}.md`);
    expect(preview.tabs.some((tab) => tab.path === "f0.md")).toBe(false);
  });

  it("折叠状态下打开会自动展开（否则用户点了预览什么也没发生）", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    preview.setCollapsed(true);
    preview.open("b.md");
    expect(preview.collapsed).toBe(false);
  });
});

describe("reload", () => {
  it("已打开的路径自增 revision（viewer 据此重载）", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    expect(preview.activeTab?.revision).toBe(0);
    preview.reload("a.md");
    expect(preview.activeTab?.revision).toBe(1);
  });

  it("未打开的路径不产生 tab，也不展开面板（后台更新不该抢焦点）", () => {
    const preview = usePreviewStore();
    preview.reload("never-opened.md");
    expect(preview.tabs).toHaveLength(0);
    expect(preview.collapsed).toBe(true);
  });
});

describe("attachDiskPath", () => {
  it("给已打开的 tab 记上落盘路径，供「用系统应用打开」定位", () => {
    const preview = usePreviewStore();
    preview.open("artifacts/a.xlsx", "a.xlsx");
    preview.attachDiskPath("artifacts/a.xlsx", "/home/u/.greyWork/artifacts/a.xlsx");
    expect(preview.activeTab?.diskPath).toBe("/home/u/.greyWork/artifacts/a.xlsx");
  });

  it("tab 已经开着时才回来的落盘路径能补上（open 的同路径早退分支带不进新参数，故另设此 action）", () => {
    const preview = usePreviewStore();
    preview.open("artifacts/a.xlsx", "a.xlsx");
    // 先开 tab、后落盘：attach 必须仍然生效
    preview.attachDiskPath("artifacts/a.xlsx", "/disk/a.xlsx");
    expect(preview.tabs[0]?.diskPath).toBe("/disk/a.xlsx");
  });

  it("已有落盘路径不覆盖（卡片认的那份才是对的），空路径是空操作", () => {
    const preview = usePreviewStore();
    preview.open("artifacts/a.xlsx", "a.xlsx");
    preview.attachDiskPath("artifacts/a.xlsx", "/first/a.xlsx");
    preview.attachDiskPath("artifacts/a.xlsx", "/second/a.xlsx");
    preview.attachDiskPath("artifacts/a.xlsx", "");
    expect(preview.activeTab?.diskPath).toBe("/first/a.xlsx");
  });

  it("未打开的路径不产生 tab，也不改 revision（只是给工具栏按钮定位，内容没变）", () => {
    const preview = usePreviewStore();
    preview.attachDiskPath("never-opened.xlsx", "/disk/a.xlsx");
    expect(preview.tabs).toHaveLength(0);

    preview.open("artifacts/a.xlsx", "a.xlsx");
    preview.attachDiskPath("artifacts/a.xlsx", "/disk/a.xlsx");
    expect(preview.activeTab?.revision).toBe(0);
  });
});

describe("setDirty 与未保存草稿的清理", () => {
  it("置起与清除脏标记；重复置同一个值不换对象（换对象会牵动下游 watch）", () => {
    const preview = usePreviewStore();
    const id = preview.open("artifacts/a.xlsx", "a.xlsx");

    preview.setDirty(id, true);
    expect(preview.activeTab?.dirty).toBe(true);
    const marked = preview.tabs[0];
    preview.setDirty(id, true);
    expect(preview.tabs[0]).toBe(marked);

    preview.setDirty(id, false);
    expect(preview.activeTab?.dirty).toBe(false);
  });

  it("对不存在的 id 是空操作", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    const before = preview.tabs[0];
    preview.setDirty("pv-nope", true);
    expect(preview.tabs[0]).toBe(before);
  });

  it("关 tab 丢掉它的草稿，别的 tab 不受影响", () => {
    const preview = usePreviewStore();
    const a = preview.open("artifacts/a.xlsx", "a.xlsx");
    const b = preview.open("artifacts/b.xlsx", "b.xlsx");
    stash(a);
    stash(b);

    preview.close(a);
    expect(hasSheetDraft(a)).toBe(false);
    expect(hasSheetDraft(b)).toBe(true);
  });

  it("关全部丢掉所有草稿", () => {
    const preview = usePreviewStore();
    const a = preview.open("artifacts/a.xlsx", "a.xlsx");
    const b = preview.open("artifacts/b.xlsx", "b.xlsx");
    stash(a);
    stash(b);

    preview.closeAll();
    expect(hasSheetDraft(a)).toBe(false);
    expect(hasSheetDraft(b)).toBe(false);
  });

  it("超过 tab 上限被淘汰的那个也要丢草稿（否则草稿永久漏内存）", () => {
    const preview = usePreviewStore();
    const ids = Array.from({ length: MAX_PREVIEW_TABS }, (_, i) => preview.open(`artifacts/${i}.xlsx`));
    for (const id of ids) stash(id);

    const newest = preview.open("artifacts/last.xlsx");
    expect(preview.tabs).toHaveLength(MAX_PREVIEW_TABS);
    // 最旧的非激活 tab 被丢弃
    expect(hasSheetDraft(ids[0])).toBe(false);
    expect(hasSheetDraft(newest)).toBe(false);
    expect(hasSheetDraft(ids[1])).toBe(true);
  });
});

describe("close", () => {
  it("关闭激活项后焦点交给右邻", () => {
    const preview = usePreviewStore();
    const a = preview.open("a.md");
    const b = preview.open("b.md");
    const c = preview.open("c.md");
    preview.activate(b);

    preview.close(b);
    expect(preview.activeId).toBe(c);
    expect(preview.tabs.map((tab) => tab.id)).toEqual([a, c]);
  });

  it("关闭最右侧激活项时焦点交给左邻", () => {
    const preview = usePreviewStore();
    const a = preview.open("a.md");
    const b = preview.open("b.md");
    preview.close(b);
    expect(preview.activeId).toBe(a);
  });

  it("关闭非激活项不动焦点", () => {
    const preview = usePreviewStore();
    const a = preview.open("a.md");
    const b = preview.open("b.md");
    preview.close(a);
    expect(preview.activeId).toBe(b);
  });

  it("关掉最后一个 tab 后面板折叠（空面板占着宽度没有意义）", () => {
    const preview = usePreviewStore();
    const a = preview.open("a.md");
    preview.close(a);
    expect(preview.tabs).toHaveLength(0);
    expect(preview.activeId).toBeNull();
    expect(preview.collapsed).toBe(true);
  });

  it("关闭不存在的 id 是空操作", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    preview.close("pv-nope");
    expect(preview.tabs).toHaveLength(1);
  });
});

describe("宽度与折叠持久化", () => {
  it("setWidth(commit) 写盘，新 store 实例能读回", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    preview.setWidth(520, true);

    setActivePinia(createPinia());
    const reloaded = usePreviewStore();
    expect(reloaded.widthPx).toBe(520);
    // 折叠偏好同源持久化：上一实例展开过，重开仍是展开
    expect(reloaded.collapsed).toBe(false);
  });

  it("拖拽中（commit=false）不写盘，只改视图", () => {
    const preview = usePreviewStore();
    preview.setWidth(500, true);
    preview.setWidth(660, false);
    expect(preview.widthPx).toBe(660);

    setActivePinia(createPinia());
    expect(usePreviewStore().widthPx).toBe(500);
  });

  it("effectiveWidthPx 折叠时为 0、展开时按容器收敛", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    preview.setWidth(700, true);
    preview.setAvailableWidth(MIN_CONTENT_PX + 400);
    expect(preview.effectiveWidthPx).toBe(400);

    preview.setCollapsed(true);
    expect(preview.effectiveWidthPx).toBe(0);
  });

  it("容器窄到装不下会话区 + 右栏时自动折叠", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    expect(preview.collapsed).toBe(false);
    preview.setAvailableWidth(MIN_CONTENT_PX + MIN_PREVIEW_PANEL_PX - 1);
    expect(preview.collapsed).toBe(true);
  });

  it("损坏的持久化数据回落默认值", () => {
    storage.set("greywork.preview.panel", "{ not json");
    const preview = usePreviewStore();
    expect(preview.widthPx).toBe(DEFAULT_PREVIEW_PANEL_PX);
    expect(preview.collapsed).toBe(true);
  });
});

describe("closeAll", () => {
  it("清空 tab 并折叠", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    preview.open("b.md");
    preview.closeAll();
    expect(preview.tabs).toHaveLength(0);
    expect(preview.activeId).toBeNull();
    expect(preview.collapsed).toBe(true);
  });
});

describe("setAvailable（视口是否渲染右栏）", () => {
  it("默认可用", () => {
    expect(usePreviewStore().available).toBe(true);
  });

  it("置为不可用时不动折叠偏好 —— 切回宽屏要能恢复离开前的状态", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    expect(preview.collapsed).toBe(false);

    preview.setAvailable(false);
    expect(preview.available).toBe(false);
    expect(preview.collapsed).toBe(false);
    expect(storage.get("greywork.preview.panel")).toBe(JSON.stringify({ collapsed: false, widthPx: preview.widthPx }));

    preview.setAvailable(true);
    expect(preview.collapsed).toBe(false);
  });
});
