/**
 * 文件树的键盘导航与拖拽移动。
 *
 * 行本身是 `<button>`，所以「焦点是否落在第 N 行」用 `document.activeElement` 断言更贴近
 * 真实行为，而不是看组件内部状态。fileTree store 用桩（真 store 的 disk 节点不对外暴露，
 * 测试里铺不了数据），桩只提供组件实际读的字段。
 *
 * 覆盖：方向键 / Home / End 移动焦点、右左进出一层、F2 改名、Delete 删除、Ctrl+C/X/V
 * 走应用内剪贴板、拖拽落到目录行与空白（根），以及自投自树与同目录这类无效落点。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const stub = {
  mode: "disk" as "vfs" | "disk",
  root: "/w",
  bound: true,
  nodes: [] as { name: string; path: string; kind: "file" | "directory"; children?: unknown[] }[],
  error: null as string | null,
  loadingRoot: false,
  clipboard: null as { path: string; name: string; kind: "file" | "directory"; mode: "copy" | "cut" } | null,
  expanded: new Set<string>(),
  refresh: vi.fn(),
  bindFolder: vi.fn(async () => null),
  toggle: vi.fn(async () => undefined),
  isExpanded: (path: string) => stub.expanded.has(path),
  isLoading: () => false,
  parentOf: (path: string) => {
    const cut = path.lastIndexOf("/");
    return cut <= 0 ? "/w" : path.slice(0, cut);
  },
  createEntry: vi.fn(),
  renameEntry: vi.fn(),
  moveEntry: vi.fn(async () => undefined),
  pasteInto: vi.fn(async () => undefined),
  deleteEntry: vi.fn(async () => undefined),
  copyToClipboard: vi.fn(),
  cutToClipboard: vi.fn(),
};
vi.mock("@/stores/fileTree", () => ({ useFileTreeStore: () => stub }));

vi.mock("@/lib/open-external", () => ({ openWithSystemApp: vi.fn(async () => true) }));
vi.mock("@/lib/reveal", () => ({ revealInFolder: vi.fn(async () => true) }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => undefined) }));

import FileTree from "@/features/preview/FileTree.vue";

const SRC = {
  name: "src",
  path: "/w/src",
  kind: "directory" as const,
  children: [{ name: "a.ts", path: "/w/src/a.ts", kind: "file" as const }],
};
const TOP = { name: "top.md", path: "/w/top.md", kind: "file" as const };

/** 挂到 body 上：焦点断言看的是 document.activeElement，脱离文档的节点拿不到焦点。 */
function mountTree(): VueWrapper {
  return mount(FileTree, { attachTo: document.body });
}

/** 行按钮（按渲染顺序）。 */
function rows(wrapper: VueWrapper): HTMLButtonElement[] {
  return wrapper.findAll<HTMLButtonElement>('[data-testid="file-tree-row"]').map((entry) => entry.element);
}

/** 在第 index 行上按一个键（真实交互就是焦点在行按钮上按键）。 */
async function press(wrapper: VueWrapper, index: number, key: string, extra: Record<string, unknown> = {}): Promise<void> {
  await wrapper.findAll('[data-testid="file-tree-row"]')[index].trigger("keydown", { key, ...extra });
  await flushPromises();
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  stub.mode = "disk";
  stub.expanded = new Set(["/w/src"]);
  stub.nodes = [SRC, TOP];
  stub.clipboard = null;
  stub.refresh.mockReset();
  stub.toggle.mockReset();
  stub.renameEntry.mockReset();
  stub.moveEntry.mockReset();
  stub.pasteInto.mockReset();
  stub.deleteEntry.mockReset();
  stub.copyToClipboard.mockReset();
  stub.cutToClipboard.mockReset();
  document.body.innerHTML = "";
});

describe("文件树键盘导航", () => {
  it("方向键 / Home / End 在行之间移动焦点", async () => {
    const wrapper = mountTree();
    const [src, a, top] = rows(wrapper);
    expect([src, a, top]).toHaveLength(3);

    src.focus();
    await press(wrapper, 0, "ArrowDown");
    expect(document.activeElement).toBe(a);

    await press(wrapper, 1, "ArrowDown");
    expect(document.activeElement).toBe(top);

    // 到底了不再越界
    await press(wrapper, 2, "ArrowDown");
    expect(document.activeElement).toBe(top);

    await press(wrapper, 2, "ArrowUp");
    expect(document.activeElement).toBe(a);

    await press(wrapper, 1, "Home");
    expect(document.activeElement).toBe(src);

    await press(wrapper, 0, "End");
    expect(document.activeElement).toBe(top);
  });

  it("右键进出一层：叶子不动，左键回到父行，展开态父行先收起", async () => {
    const wrapper = mountTree();
    const [src, a] = rows(wrapper);

    // 叶子节点按右键：下一个行是更浅的 top.md，不进入
    a.focus();
    await press(wrapper, 1, "ArrowRight");
    expect(document.activeElement).toBe(a);
    expect(stub.toggle).not.toHaveBeenCalled();

    // 左键回到父目录
    await press(wrapper, 1, "ArrowLeft");
    expect(document.activeElement).toBe(src);

    // 展开态的目录按左键 → 收起
    await press(wrapper, 0, "ArrowLeft");
    expect(stub.toggle).toHaveBeenCalledWith("/w/src");
    expect(document.activeElement).toBe(src);
  });

  it("折叠的目录按右键展开", async () => {
    stub.expanded = new Set();
    const wrapper = mountTree();
    const [src] = rows(wrapper);
    src.focus();
    await press(wrapper, 0, "ArrowRight");
    expect(stub.toggle).toHaveBeenCalledWith("/w/src");
  });

  it("F2 把该行换成改名输入框；输入框里的按键不再被树接管", async () => {
    const wrapper = mountTree();
    rows(wrapper)[2].focus();
    await press(wrapper, 2, "F2");

    const input = wrapper.get('[data-testid="file-tree-rename"]');
    expect((input.element as HTMLInputElement).value).toBe("top.md");
    // 整行让位：行按钮没了
    expect(wrapper.findAll('[data-testid="file-tree-row"]')).toHaveLength(2);

    // 输入框里按方向键不该把焦点挪走（否则改名时长文本没法用光标键）
    (input.element as HTMLInputElement).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await flushPromises();
    expect(document.activeElement).toBe(input.element);
  });

  it("vfs 模式下 F2 / Delete / Ctrl+C 都无效（没有磁盘通道）", async () => {
    stub.mode = "vfs";
    const wrapper = mountTree();
    rows(wrapper)[2].focus();

    await press(wrapper, 2, "F2");
    await press(wrapper, 2, "Delete");
    await press(wrapper, 2, "c", { ctrlKey: true });

    expect(wrapper.find('[data-testid="file-tree-rename"]').exists()).toBe(false);
    expect(document.body.querySelector('[data-slot="alert-dialog-content"]')).toBeNull();
    expect(stub.copyToClipboard).not.toHaveBeenCalled();
  });

  it("Delete 弹确认，确认后才交给 store 删", async () => {
    const wrapper = mountTree();
    rows(wrapper)[2].focus();
    await press(wrapper, 2, "Delete");

    const dialog = document.body.querySelector('[data-slot="alert-dialog-content"]');
    expect(dialog?.textContent).toContain("top.md");
    expect(stub.deleteEntry).not.toHaveBeenCalled();

    [...document.body.querySelectorAll<HTMLButtonElement>('[data-slot="alert-dialog-content"] button')][1].click();
    await flushPromises();
    expect(stub.deleteEntry).toHaveBeenCalledWith("/w/top.md");
  });

  it("Ctrl+X 后 Ctrl+V：整条交给剪贴板，粘贴落到焦点行的目录", async () => {
    const wrapper = mountTree();

    rows(wrapper)[2].focus();
    await press(wrapper, 2, "x", { ctrlKey: true });
    expect(stub.cutToClipboard).toHaveBeenCalledWith({ path: "/w/top.md", name: "top.md", kind: "file" });

    rows(wrapper)[0].focus();
    await press(wrapper, 0, "v", { ctrlKey: true });
    expect(stub.pasteInto).toHaveBeenCalledWith("/w/src");
  });

  it("Ctrl+C 走复制；焦点在文件行时粘贴落到它所在的目录", async () => {
    const wrapper = mountTree();

    rows(wrapper)[1].focus();
    await press(wrapper, 1, "c", { ctrlKey: true });
    expect(stub.copyToClipboard).toHaveBeenCalledWith({ path: "/w/src/a.ts", name: "a.ts", kind: "file" });

    await press(wrapper, 1, "v", { ctrlKey: true });
    expect(stub.pasteInto).toHaveBeenCalledWith("/w/src");
  });
});

describe("文件树拖拽移动", () => {
  it("拖到目录行：移动进该目录，并高亮落点行", async () => {
    const wrapper = mount(FileTree);
    const [, , top] = rows(wrapper);

    top.dispatchEvent(new Event("dragstart", { bubbles: true }));
    await flushPromises();

    const srcRow = wrapper.get('[data-path="/w/src"]');
    const dragOver = new Event("dragover", { bubbles: true, cancelable: true });
    srcRow.element.dispatchEvent(dragOver);
    await flushPromises();
    expect(dragOver.defaultPrevented).toBe(true);
    expect(srcRow.classes().some((name) => name.includes("bg-cyan"))).toBe(true);

    srcRow.element.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(stub.moveEntry).toHaveBeenCalledWith("/w/top.md", "/w/src/top.md");
    expect(srcRow.classes().some((name) => name.includes("bg-cyan"))).toBe(false);
  });

  it("拖到文件行 = 拖到它所在的目录", async () => {
    // top.md 在根，拖到 a.ts 上等价于拖进 /w/src
    stub.nodes = [TOP, SRC];
    const wrapper = mount(FileTree);
    const [top] = rows(wrapper);

    top.dispatchEvent(new Event("dragstart", { bubbles: true }));
    await flushPromises();
    wrapper.get('[data-path="/w/src/a.ts"]').element.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await flushPromises();

    expect(stub.moveEntry).toHaveBeenCalledWith("/w/top.md", "/w/src/top.md");
  });

  it("无效落点不动：拖到自己、以及拖进自己的子树", async () => {
    const wrapper = mount(FileTree);
    const [src] = rows(wrapper);

    src.dispatchEvent(new Event("dragstart", { bubbles: true }));
    await flushPromises();
    const selfRow = wrapper.get('[data-path="/w/src"]');
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    selfRow.element.dispatchEvent(over);
    // 自投自己不是有效落点：不 preventDefault，浏览器也就不会允许 drop
    expect(over.defaultPrevented).toBe(false);
    selfRow.element.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(stub.moveEntry).not.toHaveBeenCalled();
  });

  it("拖到空白区 = 移动到根目录", async () => {
    const wrapper = mount(FileTree);
    rows(wrapper)[1].dispatchEvent(new Event("dragstart", { bubbles: true })); // /w/src/a.ts
    await flushPromises();

    const blank = wrapper.get('[data-testid="file-tree-scroll"]');
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    blank.element.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);

    blank.element.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(stub.moveEntry).toHaveBeenCalledWith("/w/src/a.ts", "/w/a.ts");
  });

  it("vfs 模式下行不可拖拽", async () => {
    stub.mode = "vfs";
    const wrapper = mount(FileTree);
    expect(rows(wrapper)[2].getAttribute("draggable")).toBe("false");
  });
});
