/**
 * 自动化任务确认卡：确认 → automation store 落一条任务且卡片转「已创建」只读态；
 * createdId 存在时再点无效（会话回放/连点都不会重复建）；取消移除提案。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import AutomationConfirmCard from "@/features/conversation/AutomationConfirmCard.vue";
import { i18n } from "@/i18n";
import { useAutomationStore } from "@/stores/automation";
import type { ThreadMessage } from "@/types";
import { pendingCloudTaskDraft } from "@/features/cloud/task-draft";
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("vue-router", async (original) => ({ ...(await original()), useRouter: () => router }));

function messageOf(draft: ThreadMessage["scheduleDraft"]): ThreadMessage {
  return { id: "m1", role: "assistant", content: "已提议", ts: Date.now(), scheduleDraft: draft };
}

function mountCard(message: ThreadMessage) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(AutomationConfirmCard, {
    props: { threadId: "t1", message },
    global: { plugins: [pinia, i18n] },
  });
  return { wrapper, message };
}

beforeEach(() => {
  localStorage.clear();
  pendingCloudTaskDraft.value = null;
  router.push.mockReset();
});

describe("AutomationConfirmCard", () => {
  it("渲染名称 / 指令 / 触发描述", () => {
    const { wrapper } = mountCard(messageOf({ name: "站会提醒", intent: "发起站会", cron: "0 9 * * *" }));
    expect(wrapper.find('[data-testid="schedule-card"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("站会提醒");
    expect(wrapper.text()).toContain("发起站会");
    expect(wrapper.find('[data-testid="schedule-confirm"]').exists()).toBe(true);
  });

  it("确认：只将草稿交给云端编辑器，云端保存成功后才标记已创建", async () => {
    const { wrapper, message } = mountCard(messageOf({ name: "日报", intent: "生成日报", cron: "0 9 * * *" }));
    const automation = useAutomationStore();
    const before = automation.list.length;
    await wrapper.get('[data-testid="schedule-confirm"]').trigger("click");
    await flushPromises();

    expect(automation.list).toHaveLength(before);
    expect(router.push).toHaveBeenCalledWith("/more/tasks");
    expect(pendingCloudTaskDraft.value).toMatchObject({ name: "日报", intent: "生成日报", cron: "0 9 * * *" });
    expect(message.scheduleDraft?.createdId).toBeUndefined();
    pendingCloudTaskDraft.value?.onCreated("at-cloud-created");
    await flushPromises();
    expect(message.scheduleDraft?.createdId).toBe("at-cloud-created");
    expect(wrapper.find('[data-testid="schedule-confirm"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="schedule-created-badge"]').exists()).toBe(true);
  });

  it("已收口的卡片没有确认/取消键：回放渲染不会重复建任务", async () => {
    const { wrapper } = mountCard(messageOf({ name: "n", intent: "i", cron: "0 9 * * *", createdId: "at-x" }));
    const automation = useAutomationStore();
    expect(wrapper.find('[data-testid="schedule-confirm"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="schedule-cancel"]').exists()).toBe(false);
    expect(automation.list.every((task) => task.name !== "n")).toBe(true);
  });

  it("已收口态是细条：名称/触发/徽标/去调整入口同行一行，指令截到第二行", async () => {
    const { wrapper } = mountCard(messageOf({ name: "站会提醒", intent: "发起站会并汇总待办", cron: "0 9 * * *", createdId: "at-x" }));

    const root = wrapper.get('[data-testid="schedule-card"]');
    expect(root.classes()).not.toContain("border");
    expect(root.classes()).not.toContain("bg-panel-2");
    expect(root.classes()).not.toContain("p-3");

    const line = root.get('[data-testid="schedule-created-badge"]').element.parentElement;
    expect(line?.textContent).toContain("站会提醒");
    expect(line?.textContent).toContain("每天 09:00");
    expect(line?.textContent).toContain("已创建");
    expect(line?.querySelector('[data-testid="schedule-go-scheduled"]')).not.toBeNull();
    // 指令留一行截断（全文在自动化任务页），不再整段展开
    expect(root.text()).toContain("发起站会并汇总待办");
    expect(root.findAll("button")).toHaveLength(1);
  });

  it("取消：提案从消息上移除", async () => {
    const { wrapper, message } = mountCard(messageOf({ name: "n", intent: "i", cron: "0 9 * * *" }));
    const automation = useAutomationStore();
    const before = automation.list.length;
    await wrapper.get('[data-testid="schedule-cancel"]').trigger("click");
    await flushPromises();
    expect(message.scheduleDraft).toBeUndefined();
    expect(automation.list).toHaveLength(before);
  });
});
