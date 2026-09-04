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
import { usePreviewStore } from "@/stores/preview";

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
