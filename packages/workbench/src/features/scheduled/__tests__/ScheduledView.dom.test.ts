// 定时任务契约：默认种子任务全量渲染；「新建任务」置顶插入一条并持久化；
// 行内编辑器把触发时间 / 执行后端写回任务。
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ScheduledView from "@/features/scheduled/ScheduledView.vue";
import { createAppRouter } from "@/router";
import { i18n, setLocale } from "@/i18n";
import { useAgentStore } from "@/stores/agent";
import { useAutomationStore } from "@/stores/automation";

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  setLocale("zh-CN");
});

async function mountView() {
  const router = createAppRouter();
  await router.push("/scheduled");
  await router.isReady();
  return mount(ScheduledView, { global: { plugins: [router, i18n] } });
}

describe("ScheduledView", () => {
  it("渲染定时任务标题与种子任务", async () => {
    const automation = useAutomationStore();
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("定时任务");
    expect(wrapper.findAll("article")).toHaveLength(automation.list.length);
    expect(wrapper.text()).toContain("整理项目状态");
  });

  it("新建任务：列表头插一条并出现「新建自动化任务」，同时展开编辑器", async () => {
    const automation = useAutomationStore();
    const before = automation.list.length;

    const wrapper = await mountView();
    const newButton = wrapper.findAll("button").find((button) => button.text().includes("新建自动化"));
    expect(newButton).toBeDefined();
    await newButton!.trigger("click");

    expect(automation.list.length).toBe(before + 1);
    expect(wrapper.findAll("article")).toHaveLength(before + 1);
    expect(wrapper.text()).toContain("新建自动化任务");
    expect(wrapper.find('[data-testid="schedule-editor"]').exists()).toBe(true);
  });

  it("行内编辑：选时间 + 选 ACP 后端后保存写回任务", async () => {
    const automation = useAutomationStore();
    const provider = useAgentStore().agentProviders[0];
    const wrapper = await mountView();
    const first = automation.list[0];

    await wrapper.find('[data-testid="automation-edit"]').trigger("click");
    await wrapper.find('[data-testid="schedule-mode-weekly"]').trigger("click");
    await wrapper.find('[data-testid="schedule-time"]').setValue("18:00");
    await wrapper.find('[data-testid="schedule-weekday-1"]').trigger("click");
    await wrapper.find('[data-testid="schedule-weekday-5"]').trigger("click");
    await wrapper.find('[data-testid="schedule-acp"]').setValue(provider.id);
    await wrapper.find('[data-testid="schedule-save"]').trigger("click");

    expect(first.cron).toBe("0 18 * * 5");
    expect(first.schedule).toBe("每周五 18:00");
    expect(first.acpProviderId).toBe(provider.id);
    // 编辑器收拢，行内显示新的触发描述与 ACP 徽标
    expect(wrapper.find('[data-testid="schedule-editor"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("每周五 18:00");
    expect(wrapper.find('[data-testid="automation-acp-badge"]').text()).toContain(provider.name);
  });

  it("行内编辑取消：任务保持原样，编辑器收拢", async () => {
    const automation = useAutomationStore();
    const wrapper = await mountView();
    const first = automation.list[0];
    const before = { cron: first.cron, schedule: first.schedule };

    await wrapper.find('[data-testid="automation-edit"]').trigger("click");
    await wrapper.find('[data-testid="schedule-mode-daily"]').trigger("click");
    await wrapper.find('[data-testid="schedule-time"]').setValue("23:59");
    await wrapper.find('[data-testid="schedule-cancel"]').trigger("click");

    expect(first.cron).toBe(before.cron);
    expect(first.schedule).toBe(before.schedule);
    expect(wrapper.find('[data-testid="schedule-editor"]').exists()).toBe(false);
  });
});
