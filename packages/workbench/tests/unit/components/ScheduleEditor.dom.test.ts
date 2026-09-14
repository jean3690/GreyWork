// 定时任务编辑器契约：结构化时间选择 ↔ cron 表达式、非法表达式拒绝保存、ACP 后端绑定。
import { beforeEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ScheduleEditor from "@/components/ScheduleEditor.vue";
import { useAgentStore } from "@/stores/agent";
import { i18n, setLocale } from "@/i18n";

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  setLocale("zh-CN");
});

interface Draft {
  name?: string;
  intent?: string;
  acpProviderId?: string | null;
  cron?: string | null;
}

function mountEditor(draft: Draft = {}) {
  return mount(ScheduleEditor, {
    props: {
      name: draft.name ?? "测试任务",
      intent: draft.intent ?? "生成日报",
      acpProviderId: draft.acpProviderId ?? null,
      cron: draft.cron ?? null,
    },
    global: { plugins: [i18n] },
  });
}

function text(wrapper: VueWrapper, testid: string): string {
  return wrapper.find(`[data-testid="${testid}"]`).text();
}

function saved(wrapper: VueWrapper): Record<string, unknown> {
  const events = wrapper.emitted("save");
  expect(events).toBeTruthy();
  return events![0][0] as Record<string, unknown>;
}

describe("ScheduleEditor 结构化触发时间", () => {
  it("默认手动触发：不排期，保存写入空 cron", async () => {
    const wrapper = mountEditor();
    expect(wrapper.text()).toContain("手动触发（仅 Run Now）");

    await wrapper.find('[data-testid="schedule-save"]').trigger("click");
    expect(saved(wrapper)).toMatchObject({ cron: null, schedule: "手动触发" });
  });

  it("每天：选时间即归一为 5 段表达式并给出描述与下次运行", async () => {
    const wrapper = mountEditor();
    await wrapper.find('[data-testid="schedule-mode-daily"]').trigger("click");
    await wrapper.find('[data-testid="schedule-time"]').setValue("08:30");

    expect(text(wrapper, "schedule-cron")).toBe("30 8 * * *");
    expect(text(wrapper, "schedule-description")).toBe("每天 08:30");
    expect(text(wrapper, "schedule-next")).toContain("接下来：");

    await wrapper.find('[data-testid="schedule-save"]').trigger("click");
    expect(saved(wrapper)).toMatchObject({ cron: "30 8 * * *", schedule: "每天 08:30" });
  });

  it("每周：勾选星期（标准 cron 值，0/7 = 周日）", async () => {
    const wrapper = mountEditor();
    await wrapper.find('[data-testid="schedule-mode-weekly"]').trigger("click");
    await wrapper.find('[data-testid="schedule-time"]').setValue("18:00");
    await wrapper.find('[data-testid="schedule-weekday-1"]').trigger("click"); // 取消默认的周一
    await wrapper.find('[data-testid="schedule-weekday-5"]').trigger("click"); // 周五

    expect(text(wrapper, "schedule-cron")).toBe("0 18 * * 5");
    expect(text(wrapper, "schedule-description")).toBe("每周五 18:00");

    await wrapper.find('[data-testid="schedule-save"]').trigger("click");
    expect(saved(wrapper)).toMatchObject({ cron: "0 18 * * 5" });
  });

  it("一个星期都不选：表达式不成立，保存被挡住", async () => {
    const wrapper = mountEditor({ cron: "0 9 * * 1" });
    await wrapper.find('[data-testid="schedule-weekday-1"]').trigger("click");

    expect(text(wrapper, "schedule-error")).toContain("至少选择一个星期");
    expect(wrapper.find('[data-testid="schedule-save"]').attributes("disabled")).toBeDefined();
  });

  it("每月：选日 + 时间；间隔：分钟 / 小时", async () => {
    const monthly = mountEditor();
    await monthly.find('[data-testid="schedule-mode-monthly"]').trigger("click");
    await monthly.find('[data-testid="schedule-month-day"]').setValue("15");
    await monthly.find('[data-testid="schedule-time"]').setValue("01:00");
    expect(text(monthly, "schedule-cron")).toBe("0 1 15 * *");

    const interval = mountEditor({ cron: "*/15 * * * *" });
    expect(interval.find<HTMLInputElement>('[data-testid="schedule-every"]').element.value).toBe("15");
    await interval.find('[data-testid="schedule-unit"]').setValue("hour");
    // 切到小时：回落窗口同步收窄（分字段上限 59 → 时字段上限 23）
    expect(text(interval, "schedule-cron")).toBe("0 */15 * * *");
    await interval.find('[data-testid="schedule-every"]').setValue("30");
    await interval.find('[data-testid="schedule-every"]').trigger("blur");
    expect(text(interval, "schedule-cron")).toBe("0 */23 * * *");
  });
});

describe("ScheduleEditor 自定义 cron", () => {
  it("非法表达式就地报错并拒绝保存，表达式原文保留", async () => {
    const wrapper = mountEditor({ cron: "0 9 * * 1-5" });
    await wrapper.find('[data-testid="schedule-mode-cron"]').trigger("click");
    expect(wrapper.find<HTMLInputElement>('[data-testid="schedule-cron-input"]').element.value).toBe("0 9 * * 1-5");

    await wrapper.find('[data-testid="schedule-cron-input"]').setValue("0 99 * * *");
    expect(text(wrapper, "schedule-error")).toContain("小时字段需在 0-23 范围内");
    expect(wrapper.find('[data-testid="schedule-save"]').attributes("disabled")).toBeDefined();

    await wrapper.find('[data-testid="schedule-cron-input"]').setValue("0 9 * * 1-5");
    expect(wrapper.find('[data-testid="schedule-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="schedule-save"]').attributes("disabled")).toBeUndefined();

    await wrapper.find('[data-testid="schedule-save"]').trigger("click");
    expect(saved(wrapper)).toMatchObject({ cron: "0 9 * * 1-5", schedule: "每周一、二、三、四、五 09:00" });
  });

  it("解不出的复杂表达式按原文保留（不改写用户输入）", async () => {
    const wrapper = mountEditor({ cron: "0 9 1,15 * *" });
    expect(wrapper.find<HTMLInputElement>('[data-testid="schedule-cron-input"]').element.value).toBe("0 9 1,15 * *");
    await wrapper.find('[data-testid="schedule-save"]').trigger("click");
    expect(saved(wrapper)).toMatchObject({ cron: "0 9 1,15 * *" });
  });
});

describe("ScheduleEditor 执行后端与指令", () => {
  it("ACPs 后端随保存一起写回；不选则回落到本机模型（null）", async () => {
    const provider = useAgentStore().agentProviders[0];
    const wrapper = mountEditor();
    await wrapper.find('[data-testid="schedule-acp"]').setValue(provider.id);
    await wrapper.find('[data-testid="schedule-mode-daily"]').trigger("click");
    await wrapper.find('[data-testid="schedule-save"]').trigger("click");
    expect(saved(wrapper)).toMatchObject({ acpProviderId: provider.id });

    const noBackend = mountEditor({ acpProviderId: provider.id });
    await noBackend.find('[data-testid="schedule-acp"]').setValue("");
    await noBackend.find('[data-testid="schedule-save"]').trigger("click");
    expect(saved(noBackend)).toMatchObject({ acpProviderId: null });
  });

  it("指令为空不落库（空指令到点只会空跑）", async () => {
    const wrapper = mountEditor({ intent: "" });
    expect(wrapper.find('[data-testid="schedule-save"]').attributes("disabled")).toBeDefined();
    await wrapper.find('[data-testid="schedule-intent"]').setValue("生成日报");
    expect(wrapper.find('[data-testid="schedule-save"]').attributes("disabled")).toBeUndefined();
  });

  it("取消不发保存事件", async () => {
    const wrapper = mountEditor();
    await wrapper.find('[data-testid="schedule-cancel"]').trigger("click");
    expect(wrapper.emitted("save")).toBeFalsy();
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });
});
