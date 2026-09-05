// 助手库契约：列出 agent store 的编队成员卡片（数量与内容都跟 store 对齐）。
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AssistantsView from "@/views/AssistantsView.vue";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";
import { useAgentStore } from "@/stores/agent";

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
});

describe("AssistantsView", () => {
  it("渲染助手库标题与全部编队成员卡片", async () => {
    const router = createAppRouter();
    await router.push("/assistants");
    await router.isReady();
    const agentStore = useAgentStore();
    expect(agentStore.agents.length).toBeGreaterThan(0);

    const wrapper = mount(AssistantsView, { global: { plugins: [router, i18n] } });
    expect(wrapper.text()).toContain("助手库");
    expect(wrapper.findAll("article")).toHaveLength(agentStore.agents.length);
    const first = agentStore.agents[0];
    expect(wrapper.text()).toContain(first?.name ?? "");
    expect(wrapper.text()).toContain(first?.role ?? "");
    // 状态徽标来自 store（idle 初始态）
    expect(wrapper.text()).toContain("idle");
  });
});
