/**
 * 文件树行虚拟化：超过阈值只挂载可视窗口附近的行，阈值以下保持整列。
 *
 * fileTree store 用桩（与 FileTree.contextmenu.dom.test.ts 同一套理由：真 store 的 disk
 * 节点不对外暴露，铺不了数据）。这里只关心行数与行落位，不涉及右键菜单。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const treeStub = {
  mode: "vfs" as "vfs" | "disk",
  root: "/w",
  bound: true,
  nodes: [] as { name: string; path: string; kind: "file" | "directory"; children?: unknown[] }[],
  error: null as string | null,
  loadingRoot: false,
  clipboard: null as unknown,
  refresh: vi.fn(),
  bindFolder: vi.fn(),
  toggle: vi.fn(),
  isExpanded: () => true,
  isLoading: () => false,
  createEntry: vi.fn(),
  renameEntry: vi.fn(),
  pasteInto: vi.fn(),
  deleteEntry: vi.fn(),
  copyToClipboard: vi.fn(),
  cutToClipboard: vi.fn(),
};
vi.mock("@/stores/fileTree", () => ({ useFileTreeStore: () => treeStub }));
vi.mock("@/lib/open-external", () => ({ openWithSystemApp: vi.fn() }));
vi.mock("@/lib/reveal", () => ({ revealInFolder: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));

import FileTree from "@/features/preview/FileTree.vue";

function fileNodes(count: number): { name: string; path: string; kind: "file" }[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `file-${String(index).padStart(3, "0")}.ts`,
    path: `src/file-${String(index).padStart(3, "0")}.ts`,
    kind: "file" as const,
  }));
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  treeStub.nodes = [];
  treeStub.refresh.mockReset();
});

describe("文件树行虚拟化", () => {
  it("超过阈值：只挂载可视窗口附近的行，不是整列", async () => {
    treeStub.nodes = fileNodes(200);
    const wrapper = mount(FileTree);

    const rows = wrapper.findAll('[data-testid="file-tree-row"]');
    expect(rows.length).toBeGreaterThan(0);
    // 首帧视口 initialRect 600px / 26px 行步长 ≈ 23 行 + overscan，远小于 200
    expect(rows.length).toBeLessThan(60);
    // 首屏附近的行在，末尾的不在 —— 这就是虚拟化的意义
    expect(wrapper.text()).toContain("file-000.ts");
    expect(wrapper.text()).not.toContain("file-199.ts");
    // 行按行步长绝对定位（index × 26px）
    expect(wrapper.find('[data-index="0"]').exists()).toBe(true);
  });

  it("阈值以下：整列渲染，行数等于节点数", async () => {
    treeStub.nodes = fileNodes(10);
    const wrapper = mount(FileTree);

    expect(wrapper.findAll('[data-testid="file-tree-row"]')).toHaveLength(10);
    expect(wrapper.text()).toContain("file-009.ts");
  });
});
