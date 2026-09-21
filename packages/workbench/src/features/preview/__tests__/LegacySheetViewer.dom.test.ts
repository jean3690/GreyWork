/**
 * 老格式表格（.xls）：宿主通道的取数、错误降级、工作表切换。
 *
 * 解析本身在 Rust 侧（`sheet.rs` 有自己的 fixture 用例），这里守的是渲染端的契约：
 * 只走磁盘通道、解析失败要给出可操作提示、切换工作表要真的重新解析。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import { i18n } from "@/i18n";
import type { SheetTable } from "@/lib/tabular";
import type { PreviewTab } from "@/stores/preview";

const h = vi.hoisted(() => ({ readSheet: vi.fn<(path: string, sheet?: string) => Promise<SheetTable>>() }));
vi.mock("@/state/workspaceFiles", () => ({
  readSheet: h.readSheet,
  readTextFile: vi.fn(),
  readBinaryFile: vi.fn(),
}));

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

import LegacySheetViewer from "@/features/preview/LegacySheetViewer.vue";

function sheet(overrides: Partial<SheetTable> = {}): SheetTable {
  return {
    sheets: ["Sheet1"],
    name: "Sheet1",
    rows: [
      ["name", "qty"],
      ["alpha", "10"],
      ["beta", "2"],
    ],
    truncated: false,
    ...overrides,
  };
}

function tab(partial: Partial<PreviewTab> = {}): PreviewTab {
  return { id: "pv-1", path: "/tmp/legacy.xls", name: "legacy.xls", kind: "xls", source: "disk", revision: 0, ...partial };
}

function mountViewer(partial: Partial<PreviewTab> = {}) {
  return mount(LegacySheetViewer, { props: { tab: tab(partial) }, global: { plugins: [i18n] } });
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  i18n.global.locale.value = "zh-CN";
  h.readSheet.mockReset();
  h.readSheet.mockResolvedValue(sheet());
});

describe("LegacySheetViewer", () => {
  it("解析成功：把宿主返回的网格铺出来（首行当表头）", async () => {
    const wrapper = mountViewer();
    await flushPromises();

    const table = wrapper.get('[data-testid="legacy-sheet-viewer"]');
    expect(table.findAll("thead th").map((node) => node.text())).toEqual(["name", "qty"]);
    expect(table.findAll("tbody tr")).toHaveLength(2);
    expect(h.readSheet).toHaveBeenCalledWith("/tmp/legacy.xls", undefined);
  });

  it("解析失败：给出错误与「用系统应用打开」的指引，而不是一个空白面板", async () => {
    h.readSheet.mockRejectedValue(new Error("无法识别表格格式：bad magic"));
    const wrapper = mountViewer();
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain("无法解析这个表格：无法识别表格格式：bad magic");
    expect(wrapper.text()).toContain("用系统应用打开原文件");
  });

  it("内存产物（vfs）没有磁盘路径：直接给人话错误，不去调宿主命令", async () => {
    const wrapper = mountViewer({ source: "vfs", path: "reports/legacy.xls" });
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain("内存里的产物没有 .xls，无法解析");
    expect(h.readSheet).not.toHaveBeenCalled();
  });

  it("多工作表才出选择器；切换后按新表名重新解析", async () => {
    h.readSheet.mockResolvedValue(sheet({ sheets: ["Sheet1", "备注"] }));
    const wrapper = mountViewer();
    await flushPromises();

    const select = wrapper.get('[data-testid="legacy-sheet-select"]');
    expect(select.findAll("option").map((node) => node.text())).toEqual(["Sheet1", "备注"]);

    await select.setValue("备注");
    await flushPromises();
    expect(h.readSheet.mock.calls.at(-1)?.[1]).toBe("备注");
  });

  it("单工作表不出选择器（没得选的东西不该占位置）", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    expect(wrapper.find('[data-testid="legacy-sheet-select"]').exists()).toBe(false);
  });

  it("切到分析模式：表格让位给分析面板", async () => {
    const wrapper = mountViewer({ mode: "analysis" });
    await flushPromises();

    expect(wrapper.find('[data-testid="legacy-sheet-viewer"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="analysis-panel-stub"]').exists()).toBe(true);
  });
});
