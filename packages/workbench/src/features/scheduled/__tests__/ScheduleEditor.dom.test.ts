// 定时任务编辑器契约：结构化时间选择 ↔ cron 表达式、日历/时间选择器接入、
// 一次性任务的 onceAt、非法表达式拒绝保存、ACP 后端绑定。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ScheduleEditor from "@/features/scheduled/ScheduleEditor.vue";
import { useAgentStore } from "@/stores/agent";
import { i18n, setLocale } from "@/i18n";

// 日历与滚轮都 Portal 到 body：断言一律查 document.body，且挂载要 attachTo + 显式 unmount。
const mounted: VueWrapper[] = [];

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  setLocale("zh-CN");
  // 只伪造 Date：正午之前的固定时刻让「今天」可预期，又不干扰 rAF / setTimeout。
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 0, 15, 9, 0, 0));
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

interface Draft {
  name?: string;
  intent?: string;
  acpProviderId?: string | null;
  cron?: string | null;
  onceAt?: number | null;
}

function mountEditor(draft: Draft = {}) {
  const wrapper = mount(ScheduleEditor, {
    props: {
      name: draft.name ?? "测试任务",
      intent: draft.intent ?? "生成日报",
      acpProviderId: draft.acpProviderId ?? null,
      cron: draft.cron ?? null,
      onceAt: draft.onceAt ?? null,
    },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

function text(wrapper: VueWrapper, testid: string): string {
  return wrapper.find(`[data-testid="${testid}"]`).text();
}

function saved(wrapper: VueWrapper): Record<string, unknown> {
  const events = wrapper.emitted("save");
  expect(events).toBeTruthy();
  return events![0][0] as Record<string, unknown>;
}

/** 时间选择器：开弹层 → 点时 / 分（弹层在 body 上，wrapper.find 够不到）。 */
async function pickTime(wrapper: VueWrapper, testId: string, hour: number, minute: number): Promise<void> {
  await wrapper.find(`[data-testid="${testId}"]`).trigger("click");
  await flushPromises();
  const popover = document.body.querySelector(`[data-testid="${testId}-popover"]`);
  if (!popover) throw new Error(`未渲染出 ${testId} 时间弹层`);
  const panel = new DOMWrapper(popover);
  await panel.find(`[data-testid="${testId}-hour-${hour}"]`).trigger("click");
  await panel.find(`[data-testid="${testId}-minute-${minute}"]`).trigger("click");
}

/** 日期选择器：开日历 → 点当月某一天（跨月/禁用格子排除在外）。 */
async function pickDate(wrapper: VueWrapper, testId: string, day: number): Promise<void> {
  await wrapper.find(`[data-testid="${testId}"]`).trigger("click");
  await flushPromises();
  const panel = document.body.querySelector(`[data-testid="${testId}-calendar"]`);
  if (!panel) throw new Error(`未渲染出 ${testId} 日历`);
  const cell = [...panel.querySelectorAll<HTMLElement>('[data-slot="calendar-cell-trigger"]')].find(
    (element) => element.textContent?.trim() === String(day) && !element.hasAttribute("data-outside-view"),
  );
  if (!cell) throw new Error(`日历里没有可点的 ${day} 号`);
  cell.click();
  await flushPromises();
}

describe("ScheduleEditor 结构化触发时间", () => {
  it("默认手动触发：不排期，保存写入空 cron", async () => {
    const wrapper = mountEditor();
    expect(wrapper.text()).toContain("手动触发（仅 Run Now）");

    await wrapper.find('[data-testid="schedule-save"]').trigger("click");
    expect(saved(wrapper)).toMatchObject({ cron: null, onceAt: null, schedule: "手动触发" });
  });

  it("每天：时间选择器选时刻即归一为 5 段表达式并给出描述与下次运行", async () => {
    const wrapper = mountEditor();
    await wrapper.find('[data-testid="schedule-mode-daily"]').trigger("click");
    await pickTime(wrapper, "schedule-time", 8, 30);

    expect(text(wrapper, "schedule-cron")).toBe("30 8 * * *");
    expect(text(wrapper, "schedule-description")).toBe("每天 08:30");
    expect(text(wrapper, "schedule-next")).toContain("接下来：");

    await wrapper.find('[data-testid="schedule-save"]').trigger("click");
    expect(saved(wrapper)).toMatchObject({ cron: "30 8 * * *", onceAt: null, schedule: "每天 08:30" });
  });

  it("每周：勾选星期（标准 cron 值，0/7 = 周日）", async () => {
    const wrapper = mountEditor();
    await wrapper.find('[data-testid="schedule-mode-weekly"]').trigger("click");
    await pickTime(wrapper, "schedule-time", 18, 0);
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

  it("每月：日历点选「每月第几天」+ 时间", async () => {
    const wrapper = mountEditor();
    await wrapper.find('[data-testid="schedule-mode-monthly"]').trigger("click");
    expect(wrapper.find('[data-testid="schedule-month-day"]').text()).toBe("每月 1 日");

    await pickDate(wrapper, "schedule-month-day", 15);
    await pickTime(wrapper, "schedule-time", 1, 0);

    expect(wrapper.find('[data-testid="schedule-month-day"]').text()).toBe("每月 15 日");
    expect(text(wrapper, "schedule-cron")).toBe("0 1 15 * *");
    expect(text(wrapper, "schedule-description")).toBe("每月 15 日 01:00");
  });

  it("每年：日历点选月/日 + 时间 → 四段受限表达式", async () => {
    const wrapper = mountEditor();
    await wrapper.find('[data-testid="schedule-mode-yearly"]').trigger("click");
    await pickDate(wrapper, "schedule-year-day", 20);
    await pickTime(wrapper, "schedule-time", 9, 0);

    expect(wrapper.find('[data-testid="schedule-year-day"]').text()).toBe("每年 1 月 20 日");
    expect(text(wrapper, "schedule-cron")).toBe("0 9 20 1 *");
    expect(text(wrapper, "schedule-description")).toBe("每年 1 月 20 日 09:00");

    await wrapper.find('[data-testid="schedule-save"]').trigger("click");
    expect(saved(wrapper)).toMatchObject({ cron: "0 9 20 1 *", onceAt: null });
  });

  it("间隔：分钟 / 小时", async () => {
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

describe("ScheduleEditor 一次性任务", () => {
  it("指定日期时间：保存写 onceAt、不写 cron，描述带年月日", async () => {
    const wrapper = mountEditor();
    await wrapper.find('[data-testid="schedule-mode-once"]').trigger("click");
    // 未选日期时不能保存（没有触发时刻可言）
    expect(wrapper.find('[data-testid="schedule-save"]').attributes("disabled")).toBeDefined();

    await pickDate(wrapper, "schedule-once-date", 20);
    await pickTime(wrapper, "schedule-once-time", 8, 30);

    const expected = new Date(2026, 0, 20, 8, 30, 0, 0).getTime();
    expect(text(wrapper, "schedule-description")).toContain("2026");
    await wrapper.find('[data-testid="schedule-save"]').trigger("click");
    const patch = saved(wrapper);
    expect(patch).toMatchObject({ cron: null, onceAt: expected });
    expect(String(patch.schedule)).toContain("仅一次");
  });

  it("过去的时刻不落库：报错并挡住保存", async () => {
    const wrapper = mountEditor({ onceAt: new Date(2026, 0, 14, 8, 0, 0).getTime() });
    expect(text(wrapper, "schedule-error")).toContain("已经过去");
    expect(wrapper.find('[data-testid="schedule-save"]').attributes("disabled")).toBeDefined();

    // 改到将来即可保存
    await pickDate(wrapper, "schedule-once-date", 16);
    expect(wrapper.find('[data-testid="schedule-save"]').attributes("disabled")).toBeUndefined();
    await wrapper.find('[data-testid="schedule-save"]').trigger("click");
    expect(saved(wrapper)).toMatchObject({ onceAt: new Date(2026, 0, 16, 8, 0, 0).getTime() });
  });

  it("已有 onceAt 的任务回填为一次性模式（不被读成手动触发）", async () => {
    const wrapper = mountEditor({ onceAt: new Date(2026, 0, 20, 8, 30, 0, 0).getTime() });
    expect(wrapper.find('[data-testid="schedule-mode-once"]').attributes("aria-pressed")).toBe("true");
    expect(text(wrapper, "schedule-once-badge")).toBe("仅一次");
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
