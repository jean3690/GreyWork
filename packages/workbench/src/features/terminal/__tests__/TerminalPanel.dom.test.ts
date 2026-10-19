/**
 * 终端面板（多标签交互式终端）：空态、shell 选择器、新建/关闭标签、状态回灌、收起。
 *
 * `TerminalView` 与宿主后端都 mock 掉 —— 这里验「标签栏 + store + 后端命令」的接线，
 * 不挂真 xterm，也不真跑 shell（xterm 与 PTY 的接线在 TerminalView.dom.test.ts）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const backend = vi.hoisted(() => ({
  shells: vi.fn(),
  list: vi.fn(),
  open: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  close: vi.fn(),
  bound: "/ws/proj" as string | null,
  /** 视图桩在挂载时模拟的事件：opened（默认）/ exited / failed。 */
  view: { mode: "opened" as "opened" | "exited" | "failed", seen: [] as string[] },
}));

vi.mock("@/lib/terminal-backend", () => ({
  terminalBackend: {
    supported: () => true,
    shells: backend.shells,
    list: backend.list,
    open: backend.open,
    write: backend.write,
    resize: backend.resize,
    close: backend.close,
  },
}));

// 视图桩：挂载即按 backend.view.mode 抛一个事件，用来验面板把事件转发给 store。
vi.mock("@/features/terminal/TerminalView.vue", async () => {
  const { defineComponent, h, onMounted } = await import("vue");
  return {
    default: defineComponent({
      name: "TerminalViewStub",
      props: { tab: { type: Object, required: true }, searchOpen: { type: Boolean, default: false } },
      emits: ["opened", "exited", "failed", "closeSearch"],
      setup(props, { emit }) {
        onMounted(() => {
          const sessionId = (props.tab as { sessionId: string }).sessionId;
          backend.view.seen.push(sessionId);
          if (backend.view.mode === "opened") emit("opened", sessionId);
          else if (backend.view.mode === "exited") emit("exited", sessionId);
          else emit("failed", sessionId, "boom");
        });
        return () =>
          h("div", {
            "data-testid": "terminal-view-stub",
            "data-search-open": props.searchOpen ? "true" : "false",
          });
      },
    }),
  };
});

// 启动目录走「当前工作区」解析链；用 backend.bound 控制绑定态，避免拉进一堆 store。
vi.mock("@/lib/conversation-folder", () => ({ activeConversationFolder: () => backend.bound }));
vi.mock("@/lib/artifact-dir", () => ({ activeWorkspaceFolder: () => null }));
vi.mock("@/lib/workspace-dir", () => ({ resolveWorkspaceDir: () => Promise.resolve("/root") }));

import TerminalPanel from "@/features/terminal/TerminalPanel.vue";
import { useTerminalStore } from "@/stores/terminal";

const mounted: VueWrapper[] = [];
function mountPanel(): VueWrapper {
  // 挂到 document 上：Ctrl+F 的用例要把面板内元素的事件冒泡到 window。
  const wrapper = mount(TerminalPanel, { attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

/** 等异步链（syncCwd → loadShells → push）与视图挂载事件都落定。 */
async function settle(): Promise<void> {
  await flushPromises();
  await flushPromises();
}

/** 在 window 上派发键盘事件（全局快捷键挂在 window 上）。 */
function press(init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { ...init, cancelable: true }));
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  backend.bound = "/ws/proj";
  backend.view.mode = "opened";
  backend.view.seen = [];
  backend.shells.mockReset().mockResolvedValue({
    shells: [
      { id: "zsh", label: "Zsh" },
      { id: "bash", label: "Bash" },
    ],
    defaultId: "zsh",
  });
  backend.list.mockReset().mockResolvedValue([]);
  backend.open.mockReset().mockResolvedValue({ sessionId: "s", cwd: "/ws/proj", shellId: "zsh", shellLabel: "Zsh" });
  backend.write.mockReset().mockResolvedValue(undefined);
  backend.resize.mockReset().mockResolvedValue(undefined);
  backend.close.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

describe("TerminalPanel", () => {
  it("默认收起：无会话时渲染空态与新建入口", async () => {
    const wrapper = mountPanel();
    await settle();
    expect(wrapper.get('[data-testid="terminal-empty"]').text()).toContain("还没有终端会话");
    expect(wrapper.find('[data-testid="terminal-new-tab"]').exists()).toBe(true);
    expect(useTerminalStore().tabs).toHaveLength(0);
  });

  it("拉取 shell 列表并预选默认环境", async () => {
    const wrapper = mountPanel();
    await settle();
    const select = wrapper.get('[data-testid="terminal-shell"]');
    expect(select.findAll("option")).toHaveLength(2);
    expect((select.element as HTMLSelectElement).value).toBe("zsh");
    expect(useTerminalStore().shells).toHaveLength(2);
  });

  it("点 + 新建标签页：带上当前环境与工作目录，视图挂载后置为运行中", async () => {
    const wrapper = mountPanel();
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();

    const terminal = useTerminalStore();
    expect(terminal.tabs).toHaveLength(1);
    const tab = terminal.tabs[0];
    expect(tab.title).toBe("Zsh 1");
    expect(tab.cwd).toBe("/ws/proj");
    expect(tab.shellId).toBe("zsh");
    expect(tab.status).toBe("running");
    expect(backend.view.seen).toEqual([tab.sessionId]);
    expect(wrapper.find('[data-testid="terminal-view-stub"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="terminal-cwd"]').text()).toContain("/ws/proj");
  });

  it("切换终端环境后，新建的标签页用新环境", async () => {
    const wrapper = mountPanel();
    await settle();
    await wrapper.get('[data-testid="terminal-shell"]').setValue("bash");
    expect(useTerminalStore().pendingShellId).toBe("bash");

    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();
    const terminal = useTerminalStore();
    expect(terminal.tabs).toHaveLength(1);
    expect(terminal.tabs[0].shellId).toBe("bash");
    expect(terminal.tabs[0].title).toBe("Bash 1");
  });

  it("关闭标签页：通知宿主并移除，激活落到相邻标签", async () => {
    const wrapper = mountPanel();
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();

    const terminal = useTerminalStore();
    expect(terminal.tabs).toHaveLength(2);
    const closedId = terminal.activeId;
    const tabEls = wrapper.findAll('[data-testid="terminal-tab"]');
    expect(tabEls).toHaveLength(2);

    await tabEls[1].get('[data-testid="terminal-tab-close"]').trigger("click");
    await settle();

    expect(terminal.tabs).toHaveLength(1);
    expect(backend.close).toHaveBeenCalledWith(closedId);
    expect(terminal.activeId).toBe(terminal.tabs[0].sessionId);
  });

  it("进程退出：标签页状态置为已退出", async () => {
    backend.view.mode = "exited";
    const wrapper = mountPanel();
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();
    expect(useTerminalStore().tabs[0].status).toBe("exited");
  });

  it("启动失败：标签页状态置为错误并带文案", async () => {
    backend.view.mode = "failed";
    const wrapper = mountPanel();
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();
    const tab = useTerminalStore().tabs[0];
    expect(tab.status).toBe("error");
    expect(tab.error).toBe("boom");
  });

  it("运行中的标签页不给重启入口（避免误杀活会话）", async () => {
    const wrapper = mountPanel();
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();
    expect(useTerminalStore().tabs[0].status).toBe("running");
    expect(wrapper.find('[data-testid="terminal-restart"]').exists()).toBe(false);
  });

  it("shell 退出后可一键重启：杀掉旧会话、按同环境换新会话", async () => {
    backend.view.mode = "exited";
    const wrapper = mountPanel();
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();

    const terminal = useTerminalStore();
    const oldId = terminal.tabs[0].sessionId;
    const restart = wrapper.get('[data-testid="terminal-restart"]');

    // 新会话正常起来（旧会话已死）。
    backend.view.mode = "opened";
    await restart.trigger("click");
    await settle();

    expect(backend.close).toHaveBeenCalledWith(oldId);
    expect(terminal.tabs).toHaveLength(1);
    expect(terminal.tabs[0].sessionId).not.toBe(oldId);
    expect(terminal.tabs[0].status).toBe("running");
  });

  it("收起键把 store 的 open 拨回 false", async () => {
    const wrapper = mountPanel();
    const terminal = useTerminalStore();
    await settle();
    terminal.setOpen(true);
    await settle();
    expect(terminal.open).toBe(true);

    await wrapper.get('[data-testid="terminal-collapse"]').trigger("click");
    expect(terminal.open).toBe(false);
  });

  it("渲染进程重载后接回宿主里仍在跑的会话，不再重复开会话", async () => {
    localStorage.setItem(
      "greywork.terminal",
      JSON.stringify({
        open: true,
        tabs: [{ sessionId: "old-1", title: "Zsh 1", cwd: "/stale", shellId: "zsh", shellLabel: "Zsh" }],
        activeId: "old-1",
      }),
    );
    backend.list.mockResolvedValue([{ sessionId: "old-1", cwd: "/ws/proj", shellId: "zsh", shellLabel: "Zsh" }]);

    const wrapper = mountPanel();
    await settle();

    const terminal = useTerminalStore();
    expect(backend.list).toHaveBeenCalledTimes(1);
    expect(terminal.tabs).toHaveLength(1);
    // 目录 / shell 以宿主为准（落盘的可能已过期），标签接上而不是新开。
    expect(terminal.tabs[0]).toMatchObject({
      sessionId: "old-1",
      cwd: "/ws/proj",
      status: "running",
      attached: true,
    });
    expect(terminal.activeId).toBe("old-1");
    expect(wrapper.find('[data-testid="terminal-view-stub"]').exists()).toBe(true);
  });

  it("偏好里的会话已经不在宿主里：丢弃过期标签，展开时新开一个", async () => {
    localStorage.setItem(
      "greywork.terminal",
      JSON.stringify({
        open: true,
        tabs: [{ sessionId: "gone", title: "Zsh 1", cwd: "/ws/proj", shellId: "zsh", shellLabel: "Zsh" }],
        activeId: "gone",
      }),
    );
    backend.list.mockResolvedValue([]);

    const wrapper = mountPanel();
    await settle();

    const terminal = useTerminalStore();
    expect(terminal.tabs).toHaveLength(1);
    expect(terminal.tabs[0].sessionId).not.toBe("gone");
    expect(terminal.tabs[0].status).toBe("running");
    expect(wrapper.get('[data-testid="terminal-cwd"]').text()).toContain("/ws/proj");
  });

  it("宿主里有会话但偏好里没有：补成标签接回（孤儿回收）", async () => {
    backend.list.mockResolvedValue([{ sessionId: "ghost", cwd: "/ws/proj", shellId: "bash", shellLabel: "Bash" }]);

    const wrapper = mountPanel();
    await settle();

    const terminal = useTerminalStore();
    expect(terminal.tabs).toHaveLength(1);
    expect(terminal.tabs[0]).toMatchObject({
      sessionId: "ghost",
      title: "Bash 1",
      status: "running",
      attached: true,
    });
    expect(wrapper.find('[data-testid="terminal-view-stub"]').exists()).toBe(true);
  });

  it("快捷键 Ctrl+Shift+T 新建（收起时也展开），Ctrl+Shift+W 关闭当前", async () => {
    mountPanel();
    await settle();
    const terminal = useTerminalStore();
    expect(terminal.open).toBe(false);

    press({ code: "KeyT", key: "T", ctrlKey: true, shiftKey: true });
    await settle();
    expect(terminal.open).toBe(true);
    expect(terminal.tabs).toHaveLength(1);

    press({ code: "KeyW", key: "W", ctrlKey: true, shiftKey: true });
    await settle();
    expect(terminal.tabs).toHaveLength(0);
    expect(backend.close).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+F 只在焦点位于终端面板内时打开查找", async () => {
    const wrapper = mountPanel();
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();

    // 事件目标是 window（面板外）：不接管，留给编辑器 / 浏览器的查找。
    press({ code: "KeyF", key: "f", ctrlKey: true });
    await settle();
    expect(wrapper.get('[data-testid="terminal-view-stub"]').attributes("data-search-open")).toBe("false");

    // 事件从面板内的标签栏冒泡上来：接管并打开查找。
    wrapper
      .get('[data-testid="terminal-tabs"]')
      .element.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyF", key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    await settle();
    expect(wrapper.get('[data-testid="terminal-view-stub"]').attributes("data-search-open")).toBe("true");
  });

  it("快捷键 Ctrl+PageDown / PageUp 循环切换标签", async () => {
    const wrapper = mountPanel();
    await settle();
    const terminal = useTerminalStore();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();

    const [first, second] = terminal.tabs.map((tab) => tab.sessionId);
    expect(terminal.activeId).toBe(second);

    press({ code: "PageDown", key: "PageDown", ctrlKey: true });
    expect(terminal.activeId).toBe(first);
    press({ code: "PageUp", key: "PageUp", ctrlKey: true });
    expect(terminal.activeId).toBe(second);
  });

  it("双击标签重命名：回车提交，Esc 取消", async () => {
    const wrapper = mountPanel();
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();

    await wrapper.get('[data-testid="terminal-tab"]').trigger("dblclick");
    await wrapper.get('[data-testid="terminal-tab-rename"]').setValue("部署窗口");
    await wrapper.get('[data-testid="terminal-tab-rename"]').trigger("keydown.enter");
    expect(useTerminalStore().tabs[0].title).toBe("部署窗口");

    await wrapper.get('[data-testid="terminal-tab"]').trigger("dblclick");
    await wrapper.get('[data-testid="terminal-tab-rename"]').setValue("临时");
    await wrapper.get('[data-testid="terminal-tab-rename"]').trigger("keydown.esc");
    expect(useTerminalStore().tabs[0].title).toBe("部署窗口");
  });

  it("拖拽标签重排顺序", async () => {
    const wrapper = mountPanel();
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();

    const terminal = useTerminalStore();
    const [first, second] = terminal.tabs.map((tab) => tab.sessionId);
    const tabEls = wrapper.findAll('[data-testid="terminal-tab"]');
    await tabEls[0].trigger("dragstart", { dataTransfer: { setData: vi.fn(), effectAllowed: "" } });
    await tabEls[1].trigger("drop");
    await settle();

    expect(terminal.tabs.map((tab) => tab.sessionId)).toEqual([second, first]);
  });

  it("中键关闭标签，左键 auxclick 不误关", async () => {
    const wrapper = mountPanel();
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();

    const terminal = useTerminalStore();
    const tabEls = wrapper.findAll('[data-testid="terminal-tab"]');
    await tabEls[0].trigger("auxclick", { button: 0 });
    expect(terminal.tabs).toHaveLength(2);

    await tabEls[0].trigger("auxclick", { button: 1 });
    await settle();
    expect(terminal.tabs).toHaveLength(1);
    expect(backend.close).toHaveBeenCalledTimes(1);
  });

  it("分屏：单标签时新开一个放右栏；点右栏标签对调；再点取消", async () => {
    const wrapper = mountPanel();
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();
    const terminal = useTerminalStore();
    const first = terminal.activeId;

    await wrapper.get('[data-testid="terminal-split"]').trigger("click");
    await settle();

    expect(terminal.tabs).toHaveLength(2);
    expect(terminal.activeId).toBe(first);
    const splitId = terminal.splitId;
    expect(splitId).not.toBe(first);
    expect(wrapper.findAll('[data-testid="terminal-pane"]').map((pane) => pane.attributes("data-pane"))).toEqual(["main", "split"]);

    // 点右栏的标签：两边对调，避免同一会话挂两个 xterm。
    const splitIndex = terminal.tabs.findIndex((tab) => tab.sessionId === splitId);
    await wrapper.findAll('[data-testid="terminal-tab"]')[splitIndex].trigger("click");
    expect(terminal.activeId).toBe(splitId);
    expect(terminal.splitId).toBe(first);

    await wrapper.get('[data-testid="terminal-split"]').trigger("click");
    expect(terminal.splitId).toBe("");
    expect(wrapper.findAll('[data-testid="terminal-pane"]').map((pane) => pane.attributes("data-pane"))).toEqual(["hidden", "main"]);
  });

  it("关掉右栏的标签：分屏自动收起", async () => {
    const wrapper = mountPanel();
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();
    await wrapper.get('[data-testid="terminal-new-tab"]').trigger("click");
    await settle();

    const terminal = useTerminalStore();
    const splitId = terminal.tabs[0].sessionId;
    terminal.setSplit(splitId);
    expect(terminal.splitId).toBe(splitId);

    await wrapper.findAll('[data-testid="terminal-tab"]')[0].get('[data-testid="terminal-tab-close"]').trigger("click");
    await settle();
    expect(terminal.splitId).toBe("");
  });

  it("高度可调并落盘：方向键 ±8（Shift 40）、Home/End 到上下限、双击复位", async () => {
    const wrapper = mountPanel();
    await settle();
    const terminal = useTerminalStore();
    terminal.setOpen(true);
    await settle();
    const handle = wrapper.get('[data-testid="terminal-resize-handle"]');
    const start = terminal.heightPx;

    await handle.trigger("keydown", { key: "ArrowUp" });
    expect(terminal.heightPx).toBe(start + 8);
    await handle.trigger("keydown", { key: "ArrowUp", shiftKey: true });
    expect(terminal.heightPx).toBe(start + 48);
    await handle.trigger("keydown", { key: "End" });
    expect(terminal.heightPx).toBe(720);
    await handle.trigger("keydown", { key: "Home" });
    expect(terminal.heightPx).toBe(120);
    await handle.trigger("dblclick");
    expect(terminal.heightPx).toBe(240);

    expect(JSON.parse(window.localStorage.getItem("greywork.terminal") ?? "{}")).toMatchObject({ heightPx: 240 });
  });

  it("拖拽上边缘调高：向上拖 80px 就高 80px", async () => {
    const wrapper = mountPanel();
    await settle();
    const terminal = useTerminalStore();
    terminal.setOpen(true);
    await settle();
    const start = terminal.heightPx;

    const handle = wrapper.get('[data-testid="terminal-resize-handle"]').element;
    handle.dispatchEvent(new MouseEvent("pointerdown", { clientY: 400, button: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientY: 320 }));
    window.dispatchEvent(new MouseEvent("pointerup", { clientY: 320 }));
    expect(terminal.heightPx).toBe(start + 80);
  });
});
