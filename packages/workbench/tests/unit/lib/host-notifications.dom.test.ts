/**
 * `host://notify` → 系统通知的接线（lib/host-notifications.ts）。
 *
 * 只钉**消费者可见的决策**：无原生通知面就不订阅；有则订阅 `HOST_NOTIFY_EVENT` 并把载荷转给
 * `hostNotify().send`；载荷缺字段不发送；卸载退订。门面怎么把通知落到操作系统不在这层断言。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import type * as HostIpc from "@greywork/host-ipc";

const unlisten = vi.fn();
let notifyHandler: ((event: { payload: unknown }) => void) | null = null;
const send = vi.fn(() => Promise.resolve());
const listenSpy = vi.fn((_event: string, handler: (event: { payload: unknown }) => void) => {
  notifyHandler = handler;
  return Promise.resolve(unlisten);
});

let hostAvailable = true;
vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof HostIpc>()),
  hostNotify: () => (hostAvailable ? { send } : null),
  listen: (event: string, handler: (event: { payload: unknown }) => void) => listenSpy(event, handler),
}));

import { HOST_NOTIFY_EVENT } from "@greywork/host-ipc";
import { useHostNotifications } from "@/lib/host-notifications";

/** 在一个真实组件实例里挂接线（它内部用 onMounted/onUnmounted）。 */
function mountHost() {
  const Host = defineComponent({
    setup() {
      useHostNotifications();
      return () => null;
    },
  });
  return mount(Host);
}

beforeEach(() => {
  hostAvailable = true;
  notifyHandler = null;
  unlisten.mockClear();
  send.mockClear();
  listenSpy.mockClear();
});

describe("useHostNotifications", () => {
  it("无原生通知面（浏览器 / Tauri）：不订阅", async () => {
    hostAvailable = false;
    mountHost();
    await flushPromises();
    expect(listenSpy).not.toHaveBeenCalled();
    expect(notifyHandler).toBeNull();
  });

  it("有原生通知面：订阅 host://notify 并把载荷转给宿主", async () => {
    mountHost();
    await flushPromises();
    expect(listenSpy).toHaveBeenCalledWith(HOST_NOTIFY_EVENT, expect.any(Function));

    notifyHandler?.({ payload: { title: "自动化完成", body: "日报已生成" } });
    expect(send).toHaveBeenCalledWith("自动化完成", "日报已生成");
  });

  it("载荷缺字段 / 非字符串：不发送（别把 undefined 递给系统通知）", async () => {
    mountHost();
    await flushPromises();

    notifyHandler?.({ payload: { title: "只有标题" } });
    notifyHandler?.({ payload: undefined });
    notifyHandler?.({ payload: { title: 1, body: 2 } });
    expect(send).not.toHaveBeenCalled();
  });

  it("卸载退订", async () => {
    const wrapper = mountHost();
    await flushPromises();
    wrapper.unmount();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
