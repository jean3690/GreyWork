/**
 * 侧栏「协作运行」区：run 作父节点、成员位嵌套其下；点 run 回 /team，点成员位打开其会话。
 *
 * cowork store 的 slots 派生自私有 engine（真起一次 run 要拉 ACP 进程，太重），这里 mock 掉
 * store 只喂 slots/goal/status，专注验证本组件的渲染与导航接线（去重与分组在 grouped/GroupedHistory 侧）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { Router } from "vue-router";

interface FakeSlot {
  id: string;
  name: string;
  role: string;
  status: string;
  turns: number;
  threadId: string;
  wake: string;
  unread: number;
}

const h = vi.hoisted(() => ({
  slots: [] as FakeSlot[],
  goal: "把周报自动化",
  status: "running" as string | null,
}));

vi.mock("@/stores/cowork", () => ({ useCoworkStore: () => h }));

import CoworkSiderSection from "@/features/team/CoworkSiderSection.vue";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";
import { useSessionStore } from "@/stores/session";
import { useChatStore } from "@/stores/chat";

const t = i18n.global.t;

function slot(overrides: Partial<FakeSlot> = {}): FakeSlot {
  return {
    id: "slot-1",
    name: "Builder",
    role: "teammate",
    status: "ready",
    turns: 2,
    threadId: "th-1",
    wake: "idle",
    unread: 0,
    ...overrides,
  };
}

async function mountSection(path = "/guid"): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createAppRouter();
  await router.push(path);
  await router.isReady();
  const wrapper = mount(CoworkSiderSection, { global: { plugins: [pinia, i18n, router] } });
  return { wrapper, router };
}

beforeEach(() => {
  localStorage.clear();
  h.slots = [];
  h.goal = "把周报自动化";
  h.status = "running";
});

describe("CoworkSiderSection", () => {
  it("无 run（slots 空）：整区零渲染", async () => {
    const { wrapper } = await mountSection();
    expect(wrapper.find('[data-testid="cowork-sider"]').exists()).toBe(false);
  });

  it("有 run：父节点显示目标与状态，成员位嵌套其下（未读计数在）", async () => {
    h.slots = [slot(), slot({ id: "slot-2", name: "Reviewer", threadId: "th-2", unread: 3 })];
    const { wrapper } = await mountSection();

    const run = wrapper.get('[data-testid="cowork-sider-run"]');
    expect(run.text()).toContain("把周报自动化");
    expect(run.text()).toContain(t("cowork.runStatus.running"));
    expect(wrapper.get('[data-testid="cowork-sider-slot-slot-1"]').text()).toContain("Builder");
    expect(wrapper.get('[data-testid="cowork-sider-slot-slot-2"]').text()).toContain("3");
  });

  it("点父节点：回协作控制台 /team", async () => {
    h.slots = [slot()];
    const { wrapper, router } = await mountSection();
    // 只断言导航意图：目标视图是懒加载的，测试环境里 push 的组件加载不会在 flushPromises 内落定。
    const push = vi.spyOn(router, "push");

    await wrapper.get('[data-testid="cowork-sider-run"]').trigger("click");

    expect(push).toHaveBeenCalledWith("/team");
  });

  it("点成员位：切激活会话并把该会话路由进主面板", async () => {
    h.slots = [slot({ threadId: "th-9" })];
    const { wrapper, router } = await mountSection();
    const push = vi.spyOn(router, "push");

    await wrapper.get('[data-testid="cowork-sider-slot-slot-1"]').trigger("click");

    expect(useSessionStore().activeSessionId).toBe("th-9");
    expect(useChatStore().activeThreadId).toBe("th-9");
    expect(push).toHaveBeenCalledWith("/conversation/th-9");
  });

  it("当前打开的就是某成员位会话时，该行高亮", async () => {
    h.slots = [slot({ threadId: "th-1" }), slot({ id: "slot-2", name: "Reviewer", threadId: "th-2" })];
    const { wrapper } = await mountSection("/conversation/th-1");

    expect(wrapper.get('[data-testid="cowork-sider-slot-slot-1"]').attributes("aria-current")).toBe("true");
    expect(wrapper.get('[data-testid="cowork-sider-slot-slot-2"]').attributes("aria-current")).toBeUndefined();
  });
});
