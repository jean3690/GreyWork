/**
 * 分析网格：点表头的排序循环（升 → 降 → 不排）与有界渲染。
 *
 * 排序本身是纯函数（`sortRows`）的职责，这里只守「点表头把什么发给父组件」——
 * 循环顺序错一步，用户就会觉得表头点不动。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { i18n } from "@/i18n";
import AnalysisGrid from "@/features/preview/AnalysisGrid.vue";
import { toDataTable } from "@/lib/tabular";
import type { SortSpec } from "@/lib/data-analysis";

const table = toDataTable({
  sheets: [],
  name: "",
  rows: [
    ["name", "qty"],
    ["b", "2"],
    ["a", "10"],
  ],
  truncated: false,
});

function mountGrid(props: { sort?: SortSpec | null; rowLimit?: number } = {}) {
  return mount(AnalysisGrid, {
    props: { columns: table.columns, rows: table.rows, sort: props.sort ?? null, rowLimit: props.rowLimit },
    global: { plugins: [i18n] },
  });
}

beforeEach(() => {
  i18n.global.locale.value = "zh-CN";
});

afterEach(() => {
  // 提示内容 Portal 到 body，用例之间必须清干净
  document.body.innerHTML = "";
});

/** 提示内容挂在 body 的 [data-slot="tooltip-content"]；含 reka 的隐藏测量副本，故用 toContain。 */
function tooltipText(): string {
  return document.body.querySelector('[data-slot="tooltip-content"]')?.textContent ?? "";
}

describe("AnalysisGrid", () => {
  it("铺出表头与全部数据行", () => {
    const wrapper = mountGrid();
    expect(wrapper.findAll("thead th").map((node) => node.text())).toEqual(["name", "qty"]);
    expect(wrapper.findAll("tbody tr")).toHaveLength(2);
  });

  it("点表头依次发 升序 → 降序 → 不排序", async () => {
    const wrapper = mountGrid();

    await wrapper.get('[data-testid="analysis-sort-1"]').trigger("click");
    expect(wrapper.emitted("update:sort")?.at(-1)).toEqual([{ column: 1, direction: "asc" }]);

    // 排序状态由父组件持有，循环的下一档要靠 prop 回灌才能走到
    await wrapper.setProps({ sort: { column: 1, direction: "asc" } });
    await wrapper.get('[data-testid="analysis-sort-1"]').trigger("click");
    expect(wrapper.emitted("update:sort")?.at(-1)).toEqual([{ column: 1, direction: "desc" }]);

    await wrapper.setProps({ sort: { column: 1, direction: "desc" } });
    await wrapper.get('[data-testid="analysis-sort-1"]').trigger("click");
    expect(wrapper.emitted("update:sort")?.at(-1)).toEqual([null]);
  });

  it("已按某列排序时，再点别的列从升序重新开始", async () => {
    const wrapper = mountGrid({ sort: { column: 0, direction: "desc" } });
    await wrapper.get('[data-testid="analysis-sort-1"]').trigger("click");
    expect(wrapper.emitted("update:sort")?.at(-1)).toEqual([{ column: 1, direction: "asc" }]);
  });

  it("排序状态可见：当前列带上方向指示，其它列没有", () => {
    const wrapper = mountGrid({ sort: { column: 1, direction: "asc" } });
    expect(wrapper.get('[data-testid="analysis-sort-1"]').find("svg").exists()).toBe(true);
    expect(wrapper.get('[data-testid="analysis-sort-0"]').find("svg").exists()).toBe(false);
  });

  it("排序提示已从原生 title 换成 Hint：键盘聚焦也能出，且说的是下一步", async () => {
    const wrapper = mountGrid();
    const button = wrapper.get('[data-testid="analysis-sort-1"]');
    expect(button.attributes("title")).toBeUndefined();

    await button.trigger("focus");
    await flushPromises();
    expect(tooltipText()).toContain(i18n.global.t("preview.analysis.sort.asc"));
  });

  it("超过渲染上限时只铺上限行数并给出提示（统计不受此限）", () => {
    const wrapper = mountGrid({ rowLimit: 1 });
    expect(wrapper.findAll("tbody tr")).toHaveLength(1);
    expect(wrapper.text()).toContain("仅显示前 1 行（共 2 行）");
  });
});
