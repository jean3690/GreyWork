/**
 * 关窗守卫的决策逻辑（lib/close-guard.ts）：对 `@greywork/host-ipc` 的 `closeGuardHost()`
 * 门面接线，不感知 Tauri / Electron。这里只钉**消费者可见的决策**：
 * - 无宿主窗口（server / 浏览器态）：不订阅。
 * - 点 X 且无脏页：直接请宿主收口（requestClose）。
 * - 点 X 且有脏页：走离开守卫，保存成功后清脏 + 同步未保存=false + 请宿主收口。
 * - 宿主发来退出请求：走同一套离开守卫，然后 confirmExit。
 * 拦截/ preventDefault 的实现细节属于门面与各宿主，不在这层断言。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import type * as HostIpc from "@greywork/host-ipc";

const unlisten = vi.fn();
let closeHandler: (() => void) | null = null;
let exitHandler: (() => void) | null = null;

const host = {
  syncUnsavedChanges: vi.fn(() => Promise.resolve()),
  requestClose: vi.fn(() => Promise.resolve()),
  confirmExit: vi.fn(() => Promise.resolve()),
  onCloseRequested: vi.fn((handler: () => void) => {
    closeHandler = handler;
    return Promise.resolve(unlisten);
  }),
  onExitRequested: vi.fn((handler: () => void) => {
    exitHandler = handler;
    return Promise.resolve(unlisten);
  }),
};

let hostAvailable = true;
vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof HostIpc>()),
  closeGuardHost: () => (hostAvailable ? host : null),
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

beforeEach(() => {
  closeHandler = null;
  exitHandler = null;
  hostAvailable = true;
  unlisten.mockClear();
  host.syncUnsavedChanges.mockClear();
  host.requestClose.mockClear();
  host.confirmExit.mockClear();
  host.onCloseRequested.mockClear();
  host.onExitRequested.mockClear();
  hasDirty.mockReset().mockReturnValue(false);
  requestLeave.mockClear();
  clearDirtyPreviewTabs.mockClear();
});

describe("useCloseGuard · 点窗口 X", () => {
  it("无宿主窗口：不订阅任何东西", () => {
    hostAvailable = false;
    mountGuard();
    expect(closeHandler).toBeNull();
    expect(host.onCloseRequested).not.toHaveBeenCalled();
  });

  it("没有未保存改动：请宿主按偏好隐藏或真关", async () => {
    mountGuard();
    await flushPromises();

    closeHandler?.();
    await flushPromises();

    expect(host.requestClose).toHaveBeenCalledOnce();
    expect(requestLeave).not.toHaveBeenCalled();
  });

  it("有未保存改动：先走离开守卫，保存成功后仍请宿主收口", async () => {
    hasDirty.mockReturnValue(true);
    mountGuard();
    await flushPromises();

    closeHandler?.();
    await flushPromises();

    expect(requestLeave).toHaveBeenCalledOnce();
    // requestLeave 的 mock 直接执行 run()，等于「自动保存全部成功」。
    expect(clearDirtyPreviewTabs).toHaveBeenCalledOnce();
    expect(host.syncUnsavedChanges).toHaveBeenCalledWith(false);
    expect(host.requestClose).toHaveBeenCalledOnce();
  });

  it("卸载后退订两条监听", async () => {
    const wrapper = mountGuard();
    await flushPromises();
    wrapper.unmount();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});

describe("useCloseGuard · 宿主发来的退出请求", () => {
  it("走同一套离开守卫，然后 confirmExit", async () => {
    mountGuard();
    await flushPromises();

    exitHandler?.();
    expect(requestLeave).toHaveBeenCalledOnce();
    expect(host.confirmExit).toHaveBeenCalledOnce();
  });
});
