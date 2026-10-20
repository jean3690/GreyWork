// 子代理指示器契约：无子代理零渲染；有子代理出胶囊，展开可见状态 / 工具数 /
// 可取消子代理的取消按钮（无 capabilities.cancel 的不给按钮）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SubagentIndicator from "@/features/conversation/SubagentIndicator.vue";
import { useAgentStore } from "@/stores/agent";
import type { SubagentState } from "@/stores/agent/state";

const h = vi.hoisted(() => ({
  cancelSubagent: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("@greywork/acp", () => ({
  createAcpClient: () => ({ isAvailable: () => true, cancelSession: () => Promise.resolve() }) as never,
  desktopHomeDir: () => Promise.resolve(null),
}));

const mounted: VueWrapper[] = [];

function makeSubagent(overrides: Partial<SubagentState> & { sessionId: string }): SubagentState {
  return {
    parentSessionId: "session-1",
    title: null,
    description: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    toolCount: 0,
    lastText: "",
    ...overrides,
  };
}

function mountIndicator(): { agent: ReturnType<typeof useAgentStore>; wrapper: VueWrapper } {
  const pinia = createPinia();
  setActivePinia(pinia);
  const agent = useAgentStore();
  // 覆写读取面；cancelSubagent 走真实 store 会在无会话时报 false，这里注入 spy。
  (agent as unknown as { cancelSubagent: typeof h.cancelSubagent }).cancelSubagent = h.cancelSubagent;
  const wrapper = mount(SubagentIndicator, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { agent, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("SubagentIndicator", () => {
  it("无子代理时零渲染", () => {
    const { wrapper } = mountIndicator();
    expect(wrapper.find('[data-testid="subagent-chip"]').exists()).toBe(false);
  });

  it("有活跃子代理时出胶囊并显示数量", async () => {
    const { agent, wrapper } = mountIndicator();
    agent.protocolSubagents = [
      makeSubagent({ sessionId: "c1", title: "调查", state: { state: "running" } }),
      makeSubagent({ sessionId: "c2", title: "测试", state: { state: "running" } }),
      makeSubagent({ sessionId: "c3", title: "已完", state: { state: "idle" } }),
    ];
    await nextTick();
    const chip = wrapper.find('[data-testid="subagent-chip"]');
    expect(chip.exists()).toBe(true);
    // 2 个活跃（running），idle 的不计入
    expect(chip.text()).toContain("2");
  });

  it("展开后可对宣告了 capabilities.cancel 的子代理取消，无能力的不给按钮", async () => {
    const { agent, wrapper } = mountIndicator();
    agent.protocolSubagents = [
      makeSubagent({ sessionId: "c1", title: "可停", state: { state: "running" }, capabilities: { cancel: {} } }),
      makeSubagent({ sessionId: "c2", title: "不可停", state: { state: "running" } }),
    ];
    await nextTick();
    await wrapper.find('[data-testid="subagent-chip"]').trigger("click");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="subagent-cancel-c1"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-testid="subagent-cancel-c2"]')).toBeNull();
    (document.querySelector('[data-testid="subagent-cancel-c1"]') as HTMLButtonElement).click();
    expect(h.cancelSubagent).toHaveBeenCalledWith("c1");
  });
});
