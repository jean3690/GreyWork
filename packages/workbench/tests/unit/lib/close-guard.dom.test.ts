/**
 * 关窗守卫：点 X 一律 `preventDefault()`，收口动作交回宿主 `close_main_window`。
 *
 * 为什么这条要钉死：Tauri 只要发现 JS 注册了 `tauri://close-requested` 监听，就把
 * 「真的关掉」整个甩给 JS 包装层；而包装层在没 `preventDefault` 时的默认动作是
 * `plugin:window|destroy` —— 那是一条渲染端没被 ACL 授权的命令，于是「关闭即退出」下
 * 点 X 完全没反应（只剩托盘能退）。见 lib/close-guard.ts 顶部与
 * apps/desktop/src-tauri/src/tray.rs 的 `close_main_window`。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";

// 变参转发：`invoke("close_main_window")` 只有一个实参，多补一个 undefined 会让
// toHaveBeenCalledWith 因数组长度不等而失配（与 lib/host-ipc 的 invoke 同一取舍）。
const invoke = vi.fn<(...args: unknown[]) => Promise<void>>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const handlers = new Map<string, (event: unknown) => void>();
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: unknown) => void) => {
    handlers.set(name, handler);
    return unlisten;
  },
}));

type CloseHandler = (event: { preventDefault: () => void }) => void;
let closeHandler: CloseHandler | null = null;
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: CloseHandler) => {
      closeHandler = handler;
      return unlisten;
    },
  }),
}));

const hasDirty = vi.fn(() => false);
const requestLeave = vi.fn((run: () => void) => run());
const clearDirtyPreviewTabs = vi.fn();
vi.mock("@/lib/preview-edit-guard", () => ({
  hasDirtyPreviewTabs: () => hasDirty(),
  requestLeave: (run: () => void) => requestLeave(run),
  clearDirtyPreviewTabs: () => clearDirtyPreviewTabs(),
}));

import { useCloseGuard } from "@/lib/close-guard";

function setTauri(on: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/** 在一个真实组件实例里挂守卫（它内部用 onUnmounted 退订）。 */
function mountGuard() {
  const Host = defineComponent({
    setup() {
      useCloseGuard();
      return () => null;
    },
  });
  return mount(Host);
}

/** 模拟点 X：Tauri 把 CloseRequested 交给 JS 时的入参形状。 */
async function clickClose(): Promise<{ preventDefault: ReturnType<typeof vi.fn> }> {
  const event = { preventDefault: vi.fn() };
  closeHandler?.(event);
  await flushPromises();
  return event;
}

beforeEach(() => {
  handlers.clear();
  closeHandler = null;
  invoke.mockReset().mockResolvedValue(undefined);
  unlisten.mockClear();
  hasDirty.mockReset().mockReturnValue(false);
  requestLeave.mockClear();
  clearDirtyPreviewTabs.mockClear();
  setTauri(false);
});

describe("useCloseGuard · 点窗口 X", () => {
  it("浏览器态：不订阅任何东西", () => {
    mountGuard();
    expect(closeHandler).toBeNull();
    expect(handlers.size).toBe(0);
  });

  it("没有未保存改动：拦下包装层，请宿主按偏好隐藏或真关", async () => {
    setTauri(true);
    mountGuard();
    await flushPromises();

    const event = await clickClose();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    // 不再调 appWindow.close()：那条路会回到包装层的 destroy()，而它没有授权。
    expect(invoke).toHaveBeenCalledWith("close_main_window");
    expect(requestLeave).not.toHaveBeenCalled();
  });

  it("有未保存改动：先走离开守卫，保存成功后仍请宿主收口", async () => {
    setTauri(true);
    hasDirty.mockReturnValue(true);
    mountGuard();
    await flushPromises();

    const event = await clickClose();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(requestLeave).toHaveBeenCalledOnce();
    // requestLeave 的 mock 直接执行 run()，等于「自动保存全部成功」。
    expect(clearDirtyPreviewTabs).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("set_unsaved_changes", { unsaved: false });
    expect(invoke).toHaveBeenCalledWith("close_main_window");
  });

  it("卸载后退订两条监听", async () => {
    setTauri(true);
    const wrapper = mountGuard();
    await flushPromises();
    wrapper.unmount();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});

describe("useCloseGuard · 宿主发来的退出请求", () => {
  it("走同一套离开守卫，然后 confirm_exit", async () => {
    setTauri(true);
    mountGuard();
    await flushPromises();

    handlers.get("close-guard:exit-requested")?.({});
    expect(requestLeave).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("confirm_exit");
  });
});
