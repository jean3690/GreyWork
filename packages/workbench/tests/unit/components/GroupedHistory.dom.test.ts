// 侧栏工作区列表渲染契约：一行一个工作区（0 会话的也在列表里，它是可切换的落点），
// 行体点击 = 切成当前工作区并展开，caret 只管展开/收起，行尾 + 在该工作区开新会话、
// ⋯ 点开才铺管理动作；兜底行「普通对话」只有 +；搜索时只留命中组、强制展开、caret 让位于结果。
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import GroupedHistory from "@/components/GroupedHistory.vue";
import GroupedHistorySessions from "@/components/GroupedHistorySessions.vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { useSessionStore } from "@/stores/session";

function workspace(id: string, name: string, folder?: string) {
  return { id, name, description: "", folder, files: [], createdAt: 1, updatedAt: 1, lastUsedAt: 1 };
}

function session(id: string, title: string, workspaceId: string | null, updatedAt: number) {
  return { id, title, workspaceId, createdAt: 1, updatedAt, messages: [] };
}

/** 落盘态直接写 localStorage：store 在实例化那一刻读它，必须早于 mount。 */
function seed(): void {
  window.localStorage.setItem(
    "greywork.workspaces",
    JSON.stringify({
      version: 2,
      workspaces: [workspace("w-alpha", "Alpha 仓", "/home/u/alpha"), workspace("w-beta", "Beta 仓"), workspace("p-general", "普通对话")],
      activeWorkspaceId: "w-alpha",
      defaultWorkspaceId: null,
    }),
  );
  window.localStorage.setItem(
    "greywork.sessions",
    JSON.stringify({
      version: 2,
      sessions: [session("s-a1", "Alpha 会话", "w-alpha", 20), session("s-free", "自由会话", null, 10)],
      activeSessionId: null,
    }),
  );
}

function mountHistory() {
  return mount(GroupedHistory, { props: { activeSessionId: null } });
}

/** 工作区行选择器：列表里每个工作区（含兜底行）各一行。 */
const ROW = '[data-testid^="workspace-row-"]';

beforeEach(() => {
  window.localStorage.clear();
  seed();
  setActivePinia(createPinia());
});

describe("GroupedHistory · 工作区列表", () => {
  it("一行一个工作区（含 0 会话的），兜底行置底", () => {
    const wrapper = mountHistory();
    expect(wrapper.findAll(ROW).map((row) => row.attributes("data-testid"))).toEqual([
      "workspace-row-w-alpha",
      "workspace-row-w-beta",
      "workspace-row-p-general",
    ]);
  });

  it("默认只展开当前工作区那一行", () => {
    const wrapper = mountHistory();
    expect(wrapper.text()).toContain("Alpha 会话");
    expect(wrapper.text()).not.toContain("自由会话");
    expect(wrapper.get('[data-testid="workspace-toggle-w-alpha"]').attributes("aria-expanded")).toBe("true");
    expect(wrapper.get('[data-testid="workspace-toggle-p-general"]').attributes("aria-expanded")).toBe("false");
  });

  it("caret 收起/展开，不动当前工作区", async () => {
    const wrapper = mountHistory();
    const store = useWorkspaceStore();
    const toggle = wrapper.get('[data-testid="workspace-toggle-w-alpha"]');

    await toggle.trigger("click");
    expect(wrapper.text()).not.toContain("Alpha 会话");
    expect(store.activeWorkspaceId).toBe("w-alpha");

    await toggle.trigger("click");
    expect(wrapper.text()).toContain("Alpha 会话");
  });

  it("点别的工作区行：切成当前并展开；空工作区就地说明", async () => {
    const wrapper = mountHistory();
    const store = useWorkspaceStore();

    await wrapper.get('[data-testid="workspace-row-w-beta"]').trigger("click");
    expect(store.activeWorkspaceId).toBe("w-beta");
    expect(wrapper.get('[data-testid="workspace-toggle-w-beta"]').attributes("aria-expanded")).toBe("true");
    expect(wrapper.text()).toContain("暂无会话");
  });

  it("管理动作藏在行尾 ⋯ 后面：点开才铺开，再点收起", async () => {
    const wrapper = mountHistory();
    expect(wrapper.find('[data-testid="workspace-rename-w-alpha"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("/home/u/alpha");

    await wrapper.get('[data-testid="workspace-menu-w-alpha"]').trigger("click");
    expect(wrapper.text()).toContain("/home/u/alpha");
    expect(wrapper.find('[data-testid="workspace-rename-w-alpha"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="workspace-default-w-alpha"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="workspace-rebind-w-alpha"]').text()).toBe("换绑文件夹");
    expect(wrapper.find('[data-testid="workspace-delete-w-alpha"]').exists()).toBe(true);

    await wrapper.get('[data-testid="workspace-menu-w-alpha"]').trigger("click");
    expect(wrapper.find('[data-testid="workspace-rename-w-alpha"]').exists()).toBe(false);
  });

  it("一次只开一个管理面板", async () => {
    const wrapper = mountHistory();
    await wrapper.get('[data-testid="workspace-menu-w-alpha"]').trigger("click");
    await wrapper.get('[data-testid="workspace-menu-w-beta"]').trigger("click");
    expect(wrapper.find('[data-testid="workspace-rename-w-alpha"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="workspace-rename-w-beta"]').exists()).toBe(true);
  });

  it("兜底行没有设置入口，只展开会话", async () => {
    const wrapper = mountHistory();
    await wrapper.get('[data-testid="workspace-row-p-general"]').trigger("click");
    expect(wrapper.text()).toContain("自由会话");
    expect(wrapper.find('[data-testid="workspace-menu-p-general"]').exists()).toBe(false);
  });

  it("行尾 + 在该工作区开新会话：切成当前工作区、展开、跳转新会话", async () => {
    const wrapper = mountHistory();
    const workspaces = useWorkspaceStore();
    const sessions = useSessionStore();

    await wrapper.get('[data-testid="workspace-new-w-beta"]').trigger("click");

    const created = sessions.sessions.find((s) => s.workspaceId === "w-beta");
    expect(created?.title).toBe("新对话");
    expect(sessions.activeSessionId).toBe(created?.id);
    expect(workspaces.activeWorkspaceId).toBe("w-beta");
    expect(wrapper.get('[data-testid="workspace-toggle-w-beta"]').attributes("aria-expanded")).toBe("true");
    expect(wrapper.emitted("navigate")?.at(-1)).toEqual([`/conversation/${created?.id}`]);
  });

  it("兜底行的 + 开出的会话仍落在兜底行", async () => {
    const wrapper = mountHistory();
    const sessions = useSessionStore();

    await wrapper.get('[data-testid="workspace-new-p-general"]').trigger("click");

    const created = sessions.sessions.find((s) => s.workspaceId === "p-general");
    expect(created).toBeDefined();
    expect(wrapper.findAll(ROW).map((row) => row.attributes("data-testid"))).toContain("workspace-row-p-general");
    expect(wrapper.get('[data-testid="workspace-row-p-general"]').text()).toContain("2");
  });

  it("搜索中新建会话会清掉关键字，免得新会话被过滤掉", async () => {
    const wrapper = mountHistory();
    const input = wrapper.get('input[aria-label="搜索会话"]');

    await input.setValue("alpha");
    expect(wrapper.findAll(ROW)).toHaveLength(1);

    await wrapper.get('[data-testid="workspace-new-w-alpha"]').trigger("click");
    expect((input.element as HTMLInputElement).value).toBe("");
    expect(wrapper.findAll(ROW)).toHaveLength(3);
    expect(wrapper.text()).toContain("新对话");
  });

  it("未绑定文件夹的工作区给「绑定文件夹」，且不再念叨落盘位置", async () => {
    const wrapper = mountHistory();
    await wrapper.get('[data-testid="workspace-menu-w-beta"]').trigger("click");
    expect(wrapper.get('[data-testid="workspace-rebind-w-beta"]').text()).toBe("绑定文件夹");
    expect(wrapper.text()).not.toContain("未绑定文件夹");
  });

  it("搜索：只留命中组、强制展开、caret 让位；清空后回到折叠态", async () => {
    const wrapper = mountHistory();
    const input = wrapper.get('input[aria-label="搜索会话"]');

    await input.setValue("alpha");
    expect(wrapper.findAll(ROW).map((row) => row.attributes("data-testid"))).toEqual(["workspace-row-w-alpha"]);
    expect(wrapper.text()).toContain("Alpha 会话");
    expect(wrapper.find('[data-testid="workspace-menu-w-alpha"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="workspace-toggle-w-alpha"]').attributes("disabled")).toBeDefined();

    await input.setValue("不存在的会话");
    expect(wrapper.findAll(ROW)).toEqual([]);
    expect(wrapper.text()).toContain("没有匹配的会话");

    await input.setValue("");
    expect(wrapper.findAll(ROW).map((row) => row.attributes("data-testid"))).toEqual([
      "workspace-row-w-alpha",
      "workspace-row-w-beta",
      "workspace-row-p-general",
    ]);
    expect(wrapper.text()).not.toContain("自由会话");
  });
});

describe("GroupedHistorySessions · 大量会话虚拟窗口", () => {
  function sessions(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      id: `s-${index}`,
      title: `历史会话 ${String(index).padStart(3, "0")}`,
      updatedAt: index,
    }));
  }

  /** 直接挂载会话列表组件：scrollElement 一开始就有（绕开父组件 ref 时序），首帧即可出窗口。 */
  function mountSessions(count: number) {
    const scroller = document.createElement("div");
    // happy-dom 无布局，offsetWidth/Height 恒 0 —— vue-virtual 用它量视口，给个假视口
    Object.defineProperty(scroller, "offsetWidth", { value: 300, configurable: true });
    Object.defineProperty(scroller, "offsetHeight", { value: 600, configurable: true });
    return {
      scroller,
      wrapper: mount(GroupedHistorySessions, {
        props: {
          sessions: sessions(count),
          activeSessionId: null,
          scrollElement: scroller,
          scrollTick: 1,
        },
      }),
    };
  }

  it("超过阈值只挂载可视窗口附近的行，而不是整列 200 行", async () => {
    const { wrapper } = mountSessions(200);
    await wrapper.vm.$nextTick();

    // 虚拟窗口行带 data-index；初始视口 initialRect 600px / 36px 行高 ≈ 17 行 + overscan，远小于 200
    const rendered = wrapper.findAll("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(60);
    // 首屏附近的会话在，末尾的不在 —— 这就是虚拟化的意义
    expect(wrapper.text()).toContain("历史会话 000");
    expect(wrapper.text()).not.toContain("历史会话 199");
  });

  it("虚拟行按行步长平移（行高恒定，index×36px 即纵坐标）", async () => {
    const { wrapper } = mountSessions(200);
    await wrapper.vm.$nextTick();
    const row = wrapper.find("[data-index='20']");
    expect(row.exists()).toBe(true);
    expect(row.attributes("style")).toContain("translateY(720px)");
  });

  it("未超阈值仍是整列渲染，不引入虚拟窗口", () => {
    const { wrapper } = mountSessions(12);
    expect(wrapper.findAll("[data-index]")).toHaveLength(0);
    expect(wrapper.text()).toContain("历史会话 011");
  });
});
