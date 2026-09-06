// 助手库契约：真实成员注册表接入前初始为空 —— 空态引导可见；有成员时按 store 对齐渲染卡片。
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
  it("首启空态：无假成员、显示引导而非冻结进度", async () => {
    const router = createAppRouter();
    await router.push("/assistants");
    await router.isReady();
    const agentStore = useAgentStore();
    expect(agentStore.agents).toHaveLength(0);

    const wrapper = mount(AssistantsView, { global: { plugins: [router, i18n] } });
    expect(wrapper.text()).toContain("助手库");
    expect(wrapper.get('[data-testid="assistants-empty"]').text()).toContain("还没有可调用的 Agent");
    expect(wrapper.findAll("article")).toHaveLength(0);
  });
});
