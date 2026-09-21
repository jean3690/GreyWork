/**
 * CSV 预览（TableViewer）：加载/失败/空文件/正常渲染、500 行上限的截断提示，
 * 以及「表格 / 分析」模式切换。
 *
 * 截断是这份组件防卡死的核心约束，必须显式守；模式切换则要守住「分析模式不渲染表格」——
 * 否则 Univer / 大表格与面板会同时挂在 DOM 上。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import { i18n } from "@/i18n";
import { usePreviewStore, type PreviewTab } from "@/stores/preview";

const h = vi.hoisted(() => ({ readFile: vi.fn<(path: string) => Promise<string>>() }));
vi.mock("@/stores/vfs", () => ({ useVfsStore: () => ({ readFile: h.readFile }) }));

// 分析面板带着 ECharts 与完整的数据加载链路（首次转译要 1s 上下），这里只关心「有没有被挂上」。
// `__esModule` 必须显式给：动态 import 拿到的是模块命名空间，Vue 靠它判断要不要取 `.default`，
// 少了它 Vue 会把整个命名空间当组件，随后 test-utils 读 `__isTeleport` 时撞上 mock 代理抛错。
vi.mock("@/features/preview/DataAnalysisPanel.vue", async () => {
  const { defineComponent, h: render } = await import("vue");
  return {
    __esModule: true,
    default: defineComponent({
      name: "DataAnalysisPanel",
      setup: () => () => render("div", { "data-testid": "analysis-panel-stub" }),
    }),
  };
});

import TableViewer from "@/features/preview/TableViewer.vue";

function tab(partial: Partial<PreviewTab> = {}): PreviewTab {
  return { id: "pv-1", path: "out/rows.csv", name: "rows.csv", kind: "csv", source: "vfs", revision: 0, ...partial };
}

function mountViewer(partial: Partial<PreviewTab> = {}) {
  return mount(TableViewer, { props: { tab: tab(partial) }, global: { plugins: [i18n] } });
}

/**
 * 分析面板是 `defineAsyncComponent` + 自己的一轮异步取数，单次 flushPromises 只够走完
 * 微任务队列的一半 —— 组件还停在 `<!---->` 占位。这里把「微任务 + 宏任务」推几轮。
 */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  i18n.global.locale.value = "zh-CN";
  h.readFile.mockReset();
  h.readFile.mockResolvedValue("name,qty\na,1\nb,2");
});

describe("TableViewer", () => {
  it("读取中：加载占位", () => {
    h.readFile.mockReturnValue(new Promise(() => {}));
    expect(mountViewer().text()).toContain("读取中");
  });

  it("读取失败：alert + 错误文案", async () => {
    h.readFile.mockRejectedValue(new Error("boom"));
    const wrapper = mountViewer();
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("读取失败：boom");
  });

  it("空文件：提示空文件", async () => {
    h.readFile.mockResolvedValue("");
    const wrapper = mountViewer();
    await flushPromises();
    expect(wrapper.text()).toContain("空文件");
  });

  it("正常渲染：表头拆自首行，body 行数 = 数据行数", async () => {
    const wrapper = mountViewer();
    await flushPromises();

    const table = wrapper.get('[data-testid="table-viewer"]');
    const headers = table.findAll("thead th");
    expect(headers.map((node) => node.text())).toEqual(["name", "qty"]);
    expect(table.findAll("tbody tr")).toHaveLength(2);
    expect(table.findAll("tbody tr")[0].findAll("td")[0].text()).toBe("a");
    expect(table.findAll("tbody tr")[1].findAll("td")[1].text()).toBe("2");
  });

  it("超 500 行：只渲染前 500 行并给出截断提示，不把几万行铺成 DOM", async () => {
    const big = ["name,qty", ...Array.from({ length: 600 }, (_, i) => `r${i},${i}`)].join("\n");
    h.readFile.mockResolvedValue(big);
    const wrapper = mountViewer();
    await flushPromises();

    const table = wrapper.get('[data-testid="table-viewer"]');
    expect(table.findAll("tbody tr")).toHaveLength(500);
    expect(wrapper.text()).toContain("仅显示前 500 行，共 600 行");
  });

  it("默认表格模式：两个模式按钮都在，表格已渲染、分析面板未挂载", async () => {
    const wrapper = mountViewer();
    await flushPromises();

    expect(wrapper.get('[data-testid="preview-mode-table"]').attributes("aria-pressed")).toBe("true");
    expect(wrapper.get('[data-testid="preview-mode-analysis"]').attributes("aria-pressed")).toBe("false");
    expect(wrapper.find('[data-testid="table-viewer"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="analysis-tab-data"]').exists()).toBe(false);
  });

  it("切到分析模式：表格让位给分析面板", async () => {
    const wrapper = mountViewer({ mode: "analysis" });
    await settle();

    expect(wrapper.find('[data-testid="table-viewer"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="analysis-panel-stub"]').exists()).toBe(true);
  });

  it("点模式按钮写回 store（模式属于 tab，不属于组件局部状态）", async () => {
    const store = usePreviewStore();
    store.tabs = [tab()];
    const wrapper = mountViewer();
    await flushPromises();

    await wrapper.get('[data-testid="preview-mode-analysis"]').trigger("click");
    expect(store.tabs[0].mode).toBe("analysis");

    await wrapper.get('[data-testid="preview-mode-table"]').trigger("click");
    expect(store.tabs[0].mode).toBe("table");
  });
});
