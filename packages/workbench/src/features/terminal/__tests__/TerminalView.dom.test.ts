/**
 * 终端视图：xterm 与 PTY 会话的 IO 接线。
 *
 * xterm / fit 插件 / 事件总线 / 宿主后端全部 mock —— 这里验三件事：
 *  1. 顺序：**先订阅 `terminal://data` 再 `terminal_open`**（否则首屏提示符会丢）；
 *  2. 转发：会话事件按 sessionId 过滤后写进 xterm，键盘输入经 `terminal_write` 回写；
 *  3. 降级：开会话失败时置错误事件，不把异常抛出去。
 * 真 xterm 渲染与真 PTY 分别由 e2e 与 Rust 单测覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import type { TerminalTab } from "@/stores/terminal";

const mocks = vi.hoisted(() => {
  const term = {
    loadAddon: vi.fn(),
    open: vi.fn(),
    onData: vi.fn(),
    onResize: vi.fn(),
    write: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    cols: 80,
    rows: 24,
  };
  return {
    term,
    fit: vi.fn(),
    listeners: new Map<string, (event: { payload: unknown }) => void>(),
    open: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
  };
});

vi.mock("@xterm/xterm", () => ({
  // `vi.fn` 不能被 `new`，用真类在构造时把 mock 方法拷到实例上。
  Terminal: class {
    constructor() {
      Object.assign(this, mocks.term);
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = mocks.fit;
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("@greywork/host-ipc", () => ({
  listen: vi.fn(async (event: string, handler: (payload: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));

vi.mock("@/lib/terminal-backend", () => ({
  terminalBackend: {
    supported: () => true,
    open: mocks.open,
    write: mocks.write,
    resize: mocks.resize,
    close: mocks.close,
  },
}));

import TerminalView from "@/features/terminal/TerminalView.vue";

const TAB: TerminalTab = {
  sessionId: "s1",
  title: "Zsh 1",
  cwd: "/ws/proj",
  shellId: "zsh",
  shellLabel: "Zsh",
  status: "starting",
};

const mounted: VueWrapper[] = [];
function mountView(tab: TerminalTab = TAB): VueWrapper {
  const wrapper = mount(TerminalView, { props: { tab } });
  mounted.push(wrapper);
  return wrapper;
}

/** 取出视图注册进 xterm 的 onData 回调（键盘输入）。 */
function onDataHandler(): (data: string) => void {
  return mocks.term.onData.mock.calls.at(-1)?.[0] as (data: string) => void;
}

beforeEach(() => {
  mocks.term.loadAddon.mockReset();
  mocks.term.open.mockReset();
  mocks.term.onData.mockReset();
  mocks.term.onResize.mockReset();
  mocks.term.write.mockReset();
  mocks.term.focus.mockReset();
  mocks.term.dispose.mockReset();
  mocks.term.cols = 80;
  mocks.term.rows = 24;
  mocks.fit.mockReset();
  mocks.listeners.clear();
  mocks.open.mockReset().mockResolvedValue({
    sessionId: "s1",
    cwd: "/ws/proj",
    shellId: "zsh",
    shellLabel: "Zsh",
  });
  mocks.write.mockReset().mockResolvedValue(undefined);
  mocks.resize.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

describe("TerminalView", () => {
  it("先订阅事件再开会话，并把实际行列交给 PTY", async () => {
    // 开会话时必须已经订阅上了 —— 这就是「首屏提示符不丢」的保证。
    let subscribedAtOpen = false;
    mocks.open.mockImplementation(async () => {
      subscribedAtOpen = mocks.listeners.has("terminal://data") && mocks.listeners.has("terminal://exit");
      return { sessionId: "s1", cwd: "/ws/proj", shellId: "zsh", shellLabel: "Zsh" };
    });

    const wrapper = mountView();
    await flushPromises();

    expect(subscribedAtOpen).toBe(true);
    expect(mocks.open).toHaveBeenCalledWith({
      sessionId: "s1",
      cwd: "/ws/proj",
      shell: "zsh",
      cols: 80,
      rows: 24,
    });
    expect(wrapper.emitted("opened")?.[0]).toEqual(["s1"]);
  });

  it("把本会话的输出 base64 解码后写进 xterm，并按 sessionId 过滤", async () => {
    mountView();
    await flushPromises();

    const data = mocks.listeners.get("terminal://data");
    expect(data).toBeTypeOf("function");
    data!({ payload: { sessionId: "s1", data: btoa("hello") } });

    expect(mocks.term.write).toHaveBeenCalledTimes(1);
    const written = mocks.term.write.mock.calls[0][0] as Uint8Array;
    expect(String.fromCharCode(...written)).toBe("hello");

    // 别的会话的数据不能串进来。
    data!({ payload: { sessionId: "other", data: btoa("nope") } });
    expect(mocks.term.write).toHaveBeenCalledTimes(1);
  });

  it("键盘输入经 terminal_write 回写；会话退出后再敲不再回写", async () => {
    mountView();
    await flushPromises();

    onDataHandler()("ls\r");
    await flushPromises();
    expect(mocks.write).toHaveBeenCalledWith("s1", "ls\r");

    mocks.listeners.get("terminal://exit")!({ payload: { sessionId: "s1" } });
    onDataHandler()("x");
    await flushPromises();
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  it("会话退出触发 exited 事件", async () => {
    const wrapper = mountView();
    await flushPromises();
    mocks.listeners.get("terminal://exit")!({ payload: { sessionId: "s1" } });
    expect(wrapper.emitted("exited")?.[0]).toEqual(["s1"]);
  });

  it("开会话失败：抛 failed 事件并带文案，不把异常抛出去", async () => {
    mocks.open.mockRejectedValue(new Error("终端需要可信本机宿主"));
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.emitted("failed")?.[0]).toEqual(["s1", "终端需要可信本机宿主"]);
  });

  it("启动慢时先亮「正在启动 shell」，首屏输出一到即收", async () => {
    const wrapper = mountView();
    await flushPromises();
    // 未到延迟阈值：不亮，避免快 shell 闪一下。
    expect(wrapper.find('[data-testid="terminal-starting"]').exists()).toBe(false);

    // 等过阈值（模拟 shell 还在跑 rc，没有输出）。
    await new Promise((resolve) => setTimeout(resolve, 400));
    await flushPromises();
    expect(wrapper.find('[data-testid="terminal-starting"]').exists()).toBe(true);

    // 首屏输出到达即收起。
    mocks.listeners.get("terminal://data")!({ payload: { sessionId: "s1", data: btoa("hi") } });
    await flushPromises();
    expect(wrapper.find('[data-testid="terminal-starting"]').exists()).toBe(false);
  });
});
