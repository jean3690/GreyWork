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

import { DEFAULT_PREVIEW_PANEL_PX, MAX_PREVIEW_TABS, MIN_CONTENT_PX, MIN_PREVIEW_PANEL_PX, MIN_WORKSPACE_PANEL_PX } from "@/lib/layout";
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

describe("moveTab（拖拽排序）", () => {
  it("重排到目标下标，不改激活项（拖拽只是整理顺序，不抢焦点）", () => {
    const preview = usePreviewStore();
    const a = preview.open("a.md");
    const b = preview.open("b.md");
    const c = preview.open("c.md");
    preview.activate(a);

    preview.moveTab(a, 2);
    expect(preview.tabs.map((tab) => tab.id)).toEqual([b, c, a]);
    expect(preview.activeId).toBe(a);
  });

  it("向后移动等价于取出再插入（下标按取出前的位置理解）", () => {
    const preview = usePreviewStore();
    const a = preview.open("a.md");
    preview.open("b.md");
    preview.open("c.md");

    preview.moveTab(a, 1);
    expect(preview.tabs.map((tab) => tab.path)).toEqual(["b.md", "a.md", "c.md"]);
  });

  it("越界下标收敛到有效区间", () => {
    const preview = usePreviewStore();
    const a = preview.open("a.md");
    preview.open("b.md");

    preview.moveTab(a, 99);
    expect(preview.tabs[1]?.path).toBe("a.md");
    preview.moveTab(a, -5);
    expect(preview.tabs[0]?.path).toBe("a.md");
  });

  it("不存在的 id 与原地放置都是空操作", () => {
    const preview = usePreviewStore();
    const a = preview.open("a.md");
    preview.open("b.md");

    preview.moveTab("pv-nope", 0);
    preview.moveTab(a, 0);
    expect(preview.tabs.map((tab) => tab.path)).toEqual(["a.md", "b.md"]);
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

describe("closeOthers", () => {
  it("只留目标 tab，其余全部关闭", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    const b = preview.open("b.md");
    preview.open("c.md");

    preview.closeOthers(b);
    expect(preview.tabs.map((tab) => tab.path)).toEqual(["b.md"]);
  });

  it("目标不是当前激活项时被提升为 activeId", () => {
    const preview = usePreviewStore();
    const a = preview.open("a.md");
    preview.open("b.md");
    preview.open("c.md");
    expect(preview.activeId).not.toBe(a);

    preview.closeOthers(a);
    expect(preview.activeId).toBe(a);
  });

  it("不存在的 id 是空操作，不误清 tab", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    const b = preview.open("b.md");

    preview.closeOthers("pv-nope");
    expect(preview.tabs.map((tab) => tab.path)).toEqual(["a.md", "b.md"]);
    expect(preview.activeId).toBe(b);
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
    expect(storage.get("greywork.preview.panel")).toBe(JSON.stringify({ collapsed: false, widthPx: preview.widthPx, ratio: null }));

    preview.setAvailable(true);
    expect(preview.collapsed).toBe(false);
  });
});

describe("px + 比例双存储（拖拽提交记比例，窗口缩放按比例重算）", () => {
  it("未测宽（availableWidth=0）时提交宽度不记比例", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    preview.setWidth(520, true);
    expect(preview.ratio).toBeNull();
  });

  it("拖拽提交时按实测宽记下比例；再次回灌宽时按比例重算 px", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    preview.setAvailableWidth(1000);
    preview.setWidth(400, true);
    expect(preview.ratio).toBeCloseTo(0.4);

    preview.setAvailableWidth(1200);
    expect(preview.widthPx).toBe(480);
    expect(preview.effectiveWidthPx).toBe(480);
  });

  it("比例重算后仍收敛进合法区间（窄窗口不会跟手缩到废）", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    preview.setAvailableWidth(1000);
    // 700 超出容器上限（1000-360=640），提交时先收敛到 640 → ratio 0.64
    preview.setWidth(700, true);
    expect(preview.ratio).toBeCloseTo(0.64);

    preview.setAvailableWidth(500);
    expect(preview.widthPx).toBe(MIN_PREVIEW_PANEL_PX);
  });

  it("重算后比例保持不变（重算只改 px，比例是上次拖拽定下的）", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    preview.setAvailableWidth(1000);
    preview.setWidth(400, true);
    preview.setAvailableWidth(1200);
    expect(preview.ratio).toBeCloseTo(0.4);
  });

  it("折叠状态下不按比例重算（面板不参与布局，重算宽度没有意义）", () => {
    const preview = usePreviewStore();
    preview.setAvailableWidth(1000);
    preview.setWidth(400, true);
    preview.setCollapsed(true);
    preview.setAvailableWidth(1500);
    expect(preview.widthPx).toBe(400);
  });
});

describe("伙伴面板预留（reservedPx）", () => {
  it("预留会挤压生效宽度，但不改偏好宽", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    preview.setAvailableWidth(1000);
    preview.setWidth(420, true);
    preview.setReserved(260);
    // 容器上限 = 1000 - MIN_CONTENT - 260 = 380
    expect(preview.effectiveWidthPx).toBe(380);
    expect(preview.widthPx).toBe(420);
  });

  it("伙伴展开让自动折叠阈值变宽：伙伴拿掉后就装不下了", () => {
    const preview = usePreviewStore();
    preview.open("a.md");
    preview.setReserved(MIN_WORKSPACE_PANEL_PX);
    preview.setAvailableWidth(MIN_CONTENT_PX + MIN_PREVIEW_PANEL_PX + MIN_WORKSPACE_PANEL_PX - 1);
    expect(preview.collapsed).toBe(true);
  });
});

/**
 * 文件树里改名 / 移动 / 删除之后，已打开的 tab 必须跟着走 —— 它们持有旧路径，
 * editor 保存用的就是 `tab.path`，不同步的话下一次保存会写回一个不存在的位置。
 */
describe("路径重定向与关闭（文件树增删改的联动）", () => {
  it("retargetPath：单个文件改名，path/name/diskPath 一起换", () => {
    const preview = usePreviewStore();
    const id = preview.open("/ws/a.md", "a.md", "disk");
    preview.retargetPath("/ws/a.md", "/ws/b.md");

    const tab = preview.tabs.find((candidate) => candidate.id === id);
    expect(tab?.path).toBe("/ws/b.md");
    expect(tab?.name).toBe("b.md");
  });

  it("retargetPath：目录整体移动，其下的 tab 按前缀一起搬", () => {
    const preview = usePreviewStore();
    const inner = preview.open("/ws/src/deep/a.ts", "a.ts", "disk");
    const outside = preview.open("/ws/other/b.md", "b.md", "disk");

    preview.retargetPath("/ws/src", "/ws/moved");

    expect(preview.tabs.find((candidate) => candidate.id === inner)?.path).toBe("/ws/moved/deep/a.ts");
    expect(preview.tabs.find((candidate) => candidate.id === inner)?.name).toBe("a.ts");
    // 不在子树里的不受影响
    expect(preview.tabs.find((candidate) => candidate.id === outside)?.path).toBe("/ws/other/b.md");
  });

  it("retargetPath 不动 revision（内容没变，重读没有意义）", () => {
    const preview = usePreviewStore();
    const id = preview.open("/ws/a.md", "a.md", "disk");
    preview.retargetPath("/ws/a.md", "/ws/b.md");
    expect(preview.tabs.find((candidate) => candidate.id === id)?.revision).toBe(0);
  });

  it("closeUnder：关掉该路径及其子路径下的 tab，其余保留", () => {
    const preview = usePreviewStore();
    const inside = preview.open("/ws/src/a.ts", "a.ts", "disk");
    const nested = preview.open("/ws/src/deep/b.ts", "b.ts", "disk");
    const sibling = preview.open("/ws/src2/c.ts", "c.ts", "disk");

    preview.closeUnder("/ws/src");

    expect(preview.tabs.map((tab) => tab.id)).toEqual([sibling]);
    expect(preview.tabs.some((tab) => tab.id === inside || tab.id === nested)).toBe(false);
  });

  it("closeUnder 关掉当前激活项时把焦点交给剩下的（不清空）", () => {
    const preview = usePreviewStore();
    preview.open("/ws/a.md", "a.md", "disk");
    const active = preview.open("/ws/b.md", "b.md", "disk");

    preview.closeUnder("/ws/b.md");

    expect(preview.tabs).toHaveLength(1);
    expect(preview.activeId).not.toBe(active);
    expect(preview.activeId).toBe(preview.tabs[0].id);
  });
});
