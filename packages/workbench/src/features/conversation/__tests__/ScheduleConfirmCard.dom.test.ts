/**
 * 定时任务确认卡：确认 → automation store 落一条任务且卡片转「已创建」只读态；
 * createdId 存在时再点无效（会话回放/连点都不会重复建）；取消移除提案。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import ScheduleConfirmCard from "@/features/conversation/ScheduleConfirmCard.vue";
import { i18n } from "@/i18n";
import { useAutomationStore } from "@/stores/automation";
import type { ThreadMessage } from "@/types";

function messageOf(draft: ThreadMessage["scheduleDraft"]): ThreadMessage {
  return { id: "m1", role: "assistant", content: "已提议", ts: Date.now(), scheduleDraft: draft };
}

function mountCard(message: ThreadMessage) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(ScheduleConfirmCard, {
    props: { threadId: "t1", message },
    global: { plugins: [pinia, i18n] },
  });
  return { wrapper, message };
}

beforeEach(() => {
  localStorage.clear();
});

describe("ScheduleConfirmCard", () => {
  it("渲染名称 / 指令 / 触发描述", () => {
    const { wrapper } = mountCard(messageOf({ name: "站会提醒", intent: "发起站会", cron: "0 9 * * *" }));
    expect(wrapper.find('[data-testid="schedule-card"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("站会提醒");
    expect(wrapper.text()).toContain("发起站会");
    expect(wrapper.find('[data-testid="schedule-confirm"]').exists()).toBe(true);
  });

  it("确认：automation 落一条启用任务，卡片转已创建只读态", async () => {
    const { wrapper, message } = mountCard(messageOf({ name: "日报", intent: "生成日报", cron: "0 9 * * *" }));
    const automation = useAutomationStore();
    const before = automation.list.length;
    await wrapper.get('[data-testid="schedule-confirm"]').trigger("click");
    await flushPromises();

    expect(automation.list).toHaveLength(before + 1);
    expect(automation.list[0]).toMatchObject({ name: "日报", intent: "生成日报", cron: "0 9 * * *", enabled: true });
    expect(message.scheduleDraft?.createdId).toBe(automation.list[0].id);
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
