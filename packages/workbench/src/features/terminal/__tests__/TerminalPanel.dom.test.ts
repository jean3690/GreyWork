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
      props: { tab: { type: Object, required: true } },
      emits: ["opened", "exited", "failed"],
      setup(props, { emit }) {
        onMounted(() => {
          const sessionId = (props.tab as { sessionId: string }).sessionId;
          backend.view.seen.push(sessionId);
          if (backend.view.mode === "opened") emit("opened", sessionId);
          else if (backend.view.mode === "exited") emit("exited", sessionId);
          else emit("failed", sessionId, "boom");
        });
        return () => h("div", { "data-testid": "terminal-view-stub" });
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
  const wrapper = mount(TerminalPanel);
  mounted.push(wrapper);
  return wrapper;
}

/** 等异步链（syncCwd → loadShells → push）与视图挂载事件都落定。 */
async function settle(): Promise<void> {
  await flushPromises();
  await flushPromises();
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
});
