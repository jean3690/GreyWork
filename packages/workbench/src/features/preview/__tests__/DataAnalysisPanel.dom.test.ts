/**
 * 分析面板：子页签分派、筛选联动、统计/分组真的算在筛选后的行上。
 *
 * ECharts 被 mock 掉：图表本身由 `chart-options` 的纯逻辑单测覆盖，happy-dom 也没有真实
 * canvas；这里只守「页签切换把图表挂上去了」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import { i18n } from "@/i18n";
import type { PreviewTab } from "@/stores/preview";

const h = vi.hoisted(() => ({ readFile: vi.fn<(path: string) => Promise<string>>() }));
vi.mock("@/stores/vfs", () => ({ useVfsStore: () => ({ readFile: h.readFile }) }));

vi.mock("@/features/preview/AnalysisChart.vue", async () => {
  const { defineComponent, h: render } = await import("vue");
  return {
    __esModule: true,
    default: defineComponent({
      name: "AnalysisChart",
      props: { table: { type: Object, required: true } },
      setup: () => () => render("div", { "data-testid": "analysis-chart-stub" }),
    }),
  };
});

import DataAnalysisPanel from "@/features/preview/DataAnalysisPanel.vue";

const CSV = ["station,riders", "A,10", "B,20", "A,30"].join("\n");

function tab(): PreviewTab {
  return { id: "pv-1", path: "out/rows.csv", name: "rows.csv", kind: "csv", source: "vfs", revision: 0 };
}

function mountPanel() {
  return mount(DataAnalysisPanel, { props: { tab: tab() }, global: { plugins: [i18n] } });
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  i18n.global.locale.value = "zh-CN";
  h.readFile.mockReset();
  h.readFile.mockResolvedValue(CSV);
});

describe("DataAnalysisPanel", () => {
  it("默认「数据」页签：网格铺出全部行，摘要给出 已筛选 / 总数", async () => {
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.get('[data-testid="analysis-tab-data"]').attributes("aria-current")).toBe("true");
    const grid = wrapper.get('[data-testid="analysis-grid"]');
    expect(grid.findAll("tbody tr")).toHaveLength(3);
    expect(grid.text()).toContain("A");
    expect(wrapper.get('[data-testid="analysis-row-summary"]').text()).toContain("3 / 3 行");
  });

  it("切到「统计」：数值列给出求和与均值", async () => {
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.get('[data-testid="analysis-tab-stats"]').trigger("click");

    const stats = wrapper.get('[data-testid="column-stats"]');
    expect(stats.text()).toContain("station");
    expect(stats.text()).toContain("riders");
    // 10 + 20 + 30 = 60，均值 20
    expect(stats.text()).toContain("60");
    expect(stats.text()).toContain("20");
  });

  it("切到「分组」：默认按首列分组、对首个数值列求和", async () => {
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.get('[data-testid="analysis-tab-group"]').trigger("click");

    const panel = wrapper.get('[data-testid="group-panel"]');
    // A = 10 + 30 = 40，B = 20
    expect(panel.text()).toContain("40");
    expect(panel.text()).toContain("20");
  });

  it("切到「图表」：把图表组件挂上（图表数据由纯逻辑单测覆盖）", async () => {
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.get('[data-testid="analysis-tab-chart"]').trigger("click");

    expect(wrapper.find('[data-testid="analysis-chart-stub"]').exists()).toBe(true);
    // 其他页签的内容不该同时留在 DOM 上
    expect(wrapper.find('[data-testid="analysis-grid"]').exists()).toBe(false);
  });

  it("筛选：条件生效后网格与摘要一起收敛，且统计算的是筛选后的行", async () => {
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.get('[data-testid="analysis-filter-toggle"]').trigger("click");
    await wrapper.get('[data-testid="analysis-filter-add"]').trigger("click");
    // 默认条件：首列 包含 ""
    await wrapper.get('[data-testid="analysis-filters"] input[type="text"]').setValue("A");
    await flushPromises();

    expect(wrapper.get('[data-testid="analysis-row-summary"]').text()).toContain("2 / 3 行");
    expect(wrapper.get('[data-testid="analysis-grid"]').findAll("tbody tr")).toHaveLength(2);

    await wrapper.get('[data-testid="analysis-tab-stats"]').trigger("click");
    // 只剩 A 的两行：10 + 30 = 40
    expect(wrapper.get('[data-testid="column-stats"]').text()).toContain("40");
  });

  it("空条件不筛掉任何行（刚添加条件还没填值时表格不该突然空掉）", async () => {
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.get('[data-testid="analysis-filter-toggle"]').trigger("click");
    await wrapper.get('[data-testid="analysis-filter-add"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="analysis-row-summary"]').text()).toContain("3 / 3 行");
  });

  it("筛选条上的删除按钮移掉该条件", async () => {
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.get('[data-testid="analysis-filter-toggle"]').trigger("click");
    await wrapper.get('[data-testid="analysis-filter-add"]').trigger("click");
    await wrapper.get('[data-testid="analysis-filters"] input[type="text"]').setValue("A");
    await flushPromises();
    expect(wrapper.get('[data-testid="analysis-row-summary"]').text()).toContain("2 / 3 行");

    const remove = wrapper.get('[data-testid="analysis-filters"] button[aria-label]');
    await remove.trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="analysis-row-summary"]').text()).toContain("3 / 3 行");
  });

  it("读取失败：alert + 错误文案", async () => {
    h.readFile.mockRejectedValue(new Error("boom"));
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain("读取失败：boom");
  });

  it("空文件：提示没有可分析的数据", async () => {
    h.readFile.mockResolvedValue("");
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.text()).toContain("没有可分析的数据");
  });
});
