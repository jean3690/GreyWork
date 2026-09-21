/**
 * 托盘桥：偏好 / 文案同步给宿主 + 订阅托盘菜单事件。
 *
 * 事件名与 src-tauri/src/tray.rs 是字符串契约（Rust 侧有同名常量测试），
 * 这里把两侧都钉住，改名时至少有一处测试会红。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<void>>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const handlers = new Map<string, (event: unknown) => void>();
const unlisten = vi.fn();
const listen = vi.fn(async (name: string, handler: (event: unknown) => void) => {
  handlers.set(name, handler);
  return unlisten;
});
vi.mock("@tauri-apps/api/event", () => ({ listen: (name: string, handler: (event: unknown) => void) => listen(name, handler) }));

import { syncCloseToTray, syncTrayLabels, useTrayBridge, type TrayLabels } from "@/lib/tray-bridge";

function setTauri(on: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

beforeEach(() => {
  handlers.clear();
  invoke.mockReset().mockResolvedValue(undefined);
  listen.mockClear();
  unlisten.mockClear();
  setTauri(false);
});

describe("syncCloseToTray", () => {
  it("浏览器态：没有宿主，不发 IPC", async () => {
    await syncCloseToTray(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("桌面态：把布尔值发给 set_close_to_tray", async () => {
    setTauri(true);
    await syncCloseToTray(false);
    expect(invoke).toHaveBeenCalledWith("set_close_to_tray", { enabled: false });
  });

  it("IPC 失败不抛出（偏好同步失败不该把设置页带下水）", async () => {
    setTauri(true);
    invoke.mockRejectedValue(new Error("boom"));
    await expect(syncCloseToTray(true)).resolves.toBeUndefined();
  });
});

describe("syncTrayLabels", () => {
  const labels: TrayLabels = {
    toggleWindow: "Show/Hide Window",
    newChat: "New Conversation",
    settings: "Open Settings",
    quit: "Quit",
    hiddenHint: "Still running",
  };

  it("浏览器态：没有宿主，不发 IPC", async () => {
    await syncTrayLabels(labels);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("桌面态：整份文案发给 set_tray_labels（宿主不持有语言）", async () => {
    setTauri(true);
    await syncTrayLabels(labels);
    // 参数名与 Rust 侧 set_tray_labels(state, labels) 对应；字段 camelCase 由 Rust
    // 的 #[serde(rename_all = "camelCase")] 接住。
    expect(invoke).toHaveBeenCalledWith("set_tray_labels", { labels });
  });

  it("IPC 失败不抛出", async () => {
    setTauri(true);
    invoke.mockRejectedValue(new Error("boom"));
    await expect(syncTrayLabels(labels)).resolves.toBeUndefined();
  });
});

describe("useTrayBridge", () => {
  it("浏览器态：不订阅，返回可安全调用的空解绑函数", () => {
    const dispose = useTrayBridge({ onNewChat: vi.fn(), onOpenSettings: vi.fn() });
    expect(listen).not.toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });

  it("桌面态：订阅两个托盘事件并派发到对应回调", async () => {
    setTauri(true);
    const onNewChat = vi.fn();
    const onOpenSettings = vi.fn();
    const dispose = useTrayBridge({ onNewChat, onOpenSettings });
    await flushPromises();

    expect(listen).toHaveBeenCalledWith("tray:new-chat", expect.any(Function));
    expect(listen).toHaveBeenCalledWith("tray:open-settings", expect.any(Function));

    handlers.get("tray:new-chat")?.({});
    handlers.get("tray:open-settings")?.({});
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();

    dispose();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });

  it("订阅落地前就卸载：落地后立刻退订，不泄漏监听", async () => {
    setTauri(true);
    const dispose = useTrayBridge({ onNewChat: vi.fn(), onOpenSettings: vi.fn() });
    dispose(); // 还没 await，订阅仍在途
    await flushPromises();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});
