/**
 * CSV 预览（TableViewer）：加载/失败/空文件/正常渲染，以及 500 行上限的截断提示。
 * 截断是这份组件防卡死的核心约束，必须显式守。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import type { PreviewTab } from "@/stores/preview";

const h = vi.hoisted(() => ({ readFile: vi.fn<(path: string) => Promise<string>>() }));
vi.mock("@/stores/vfs", () => ({ useVfsStore: () => ({ readFile: h.readFile }) }));

import TableViewer from "@/components/preview/TableViewer.vue";

function tab(partial: Partial<PreviewTab> = {}): PreviewTab {
  return { id: "pv-1", path: "out/rows.csv", name: "rows.csv", kind: "csv", source: "vfs", revision: 0, ...partial };
}

function mountViewer() {
  return mount(TableViewer, { props: { tab: tab() } });
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
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
});
