// 定时任务契约：默认种子任务全量渲染；「新建任务」置顶插入一条并持久化。
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ScheduledView from "@/views/ScheduledView.vue";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";
import { useAutomationStore } from "@/stores/automation";

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
});

describe("ScheduledView", () => {
  it("渲染定时任务标题与种子任务", async () => {
    const router = createAppRouter();
    await router.push("/scheduled");
    await router.isReady();
    const automation = useAutomationStore();

    const wrapper = mount(ScheduledView, { global: { plugins: [router, i18n] } });
    expect(wrapper.text()).toContain("定时任务");
    expect(wrapper.findAll("article")).toHaveLength(automation.list.length);
    expect(wrapper.text()).toContain("整理项目状态");
  });

  it("新建任务：列表头插一条并出现「新建自动化任务」", async () => {
    const router = createAppRouter();
    await router.push("/scheduled");
    await router.isReady();
    const automation = useAutomationStore();
    const before = automation.list.length;

    const wrapper = mount(ScheduledView, { global: { plugins: [router, i18n] } });
    const newButton = wrapper.findAll("button").find((button) => button.text().includes("新建任务"));
    expect(newButton).toBeDefined();
    await newButton!.trigger("click");

    expect(automation.list.length).toBe(before + 1);
    expect(wrapper.findAll("article")).toHaveLength(before + 1);
    expect(wrapper.text()).toContain("新建自动化任务");
  });
});
