/**
 * unified diff 预览（DiffViewer）：空 patch / 单文件段渲染（路径 + +x/-x 计数 + 行级正反标色）/
 * 5000 行段上限的截断提示。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import type { PreviewTab } from "@/stores/preview";

const h = vi.hoisted(() => ({ readFile: vi.fn<(path: string) => Promise<string>>() }));
vi.mock("@/stores/vfs", () => ({ useVfsStore: () => ({ readFile: h.readFile }) }));

import DiffViewer from "@/components/preview/DiffViewer.vue";

function tab(partial: Partial<PreviewTab> = {}): PreviewTab {
  return { id: "pv-1", path: "out/change.diff", name: "change.diff", kind: "diff", source: "vfs", revision: 0, ...partial };
}

const SAMPLE = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,3 @@",
  " const a = 1;",
  "+const b = 2;",
  "-const c = 3;",
  " 尾行不动",
].join("\n");

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  h.readFile.mockReset();
  h.readFile.mockResolvedValue(SAMPLE);
});

describe("DiffViewer", () => {
  it("读取中：加载占位", () => {
    h.readFile.mockReturnValue(new Promise(() => {}));
    expect(mount(DiffViewer, { props: { tab: tab() } }).text()).toContain("读取中");
  });

  it("读取失败：alert + 错误文案", async () => {
    h.readFile.mockRejectedValue(new Error("boom"));
    const wrapper = mount(DiffViewer, { props: { tab: tab() } });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("读取失败：boom");
  });

  it("没有可显示的变更：提示而非白屏", async () => {
    h.readFile.mockResolvedValue("");
    const wrapper = mount(DiffViewer, { props: { tab: tab() } });
    await flushPromises();
    expect(wrapper.text()).toContain("没有可显示的变更");
  });

  it("单文件段：路径、增减计数、行内容都在", async () => {
    const wrapper = mount(DiffViewer, { props: { tab: tab() } });
    await flushPromises();

    const sections = wrapper.findAll('[data-testid="diff-file"]');
    expect(sections).toHaveLength(1);
    const header = sections[0].find("header");
    expect(header.text()).toContain("app.ts");
    expect(header.text()).toContain("+1");
    expect(header.text()).toContain("-1");

    const bodyText = sections[0].text();
    expect(bodyText).toContain("const a = 1;");
    expect(bodyText).toContain("const b = 2;");
    expect(bodyText).toContain("const c = 3;");
    expect(bodyText).toContain("+const b = 2;");
    expect(bodyText).toContain("-const c = 3;");
  });

  it("超长文件段：只铺前 5000 行并给出截断提示", async () => {
    const big = [
      "--- a/src/big.ts",
      "+++ b/src/big.ts",
      "@@ -1,5001 +1,5001 @@",
      ...Array.from({ length: 5001 }, () => " const 上下文"),
    ].join("\n");
    h.readFile.mockResolvedValue(big);
    const wrapper = mount(DiffViewer, { props: { tab: tab() } });
    await flushPromises();

    expect(wrapper.text()).toContain("仅显示前 5000 行");
  });
});
