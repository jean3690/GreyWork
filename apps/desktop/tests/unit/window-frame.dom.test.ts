/**
 * Linux 主窗圆角接线：只给 label 为 `main` 的 Linux 窗口打 `data-native-shell`，并跟随
 * 最大化状态切换 `data-native-maximized`。插件悬浮窗、macOS/Windows（系统原生圆角）与
 * 无窗口宿主必须是空操作。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostWindow } from "@greywork/host-ipc";

const h = vi.hoisted(() => ({
  isMaximized: vi.fn<() => Promise<boolean>>(),
  onResized: vi.fn<(handler: () => void) => Promise<() => void>>(),
  window: null as HostWindow | null,
}));

vi.mock("@greywork/host-ipc", () => ({
  MAIN_WINDOW_LABEL: "main",
  hostWindow: () => h.window,
}));

import { installWindowFrame } from "../../src/window-frame";

function makeWindow(label: string, platform = "linux"): HostWindow {
  return {
    label,
    platform,
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    isMaximized: () => h.isMaximized(),
    show: () => Promise.resolve(),
    scaleFactor: () => Promise.resolve(1),
    startDragging: () => Promise.resolve(),
    onResized: (handler) => h.onResized(handler),
    onFocusChanged: () => Promise.resolve(() => undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.documentElement.removeAttribute("data-native-shell");
  document.documentElement.removeAttribute("data-native-maximized");
  h.isMaximized.mockResolvedValue(false);
  h.onResized.mockResolvedValue(() => undefined);
  h.window = makeWindow("main");
});

describe("installWindowFrame", () => {
  it("主窗：打上圆角标记，并按当前最大化状态切换直角标记", async () => {
    h.isMaximized.mockResolvedValue(true);

    installWindowFrame();

    expect(document.documentElement.hasAttribute("data-native-shell")).toBe(true);
    await vi.waitFor(() => expect(document.documentElement.hasAttribute("data-native-maximized")).toBe(true));
    expect(h.onResized).toHaveBeenCalledTimes(1);
  });

  it("窗口还原：resize 回调把最大化标记摘掉", async () => {
    installWindowFrame();
    await vi.waitFor(() => expect(document.documentElement.hasAttribute("data-native-maximized")).toBe(false));

    h.isMaximized.mockResolvedValue(true);
    const onResized = h.onResized.mock.calls[0]?.[0];
    onResized?.();
    await vi.waitFor(() => expect(document.documentElement.hasAttribute("data-native-maximized")).toBe(true));

    h.isMaximized.mockResolvedValue(false);
    onResized?.();
    await vi.waitFor(() => expect(document.documentElement.hasAttribute("data-native-maximized")).toBe(false));
  });

  it("插件悬浮窗：不参与整窗圆角", () => {
    h.window = makeWindow("plugin-window-demo");

    installWindowFrame();

    expect(document.documentElement.hasAttribute("data-native-shell")).toBe(false);
    expect(h.isMaximized).not.toHaveBeenCalled();
    expect(h.onResized).not.toHaveBeenCalled();
  });

  it("macOS / Windows 主窗：圆角交给系统，渲染端不打标", () => {
    h.window = makeWindow("main", "darwin");

    installWindowFrame();

    expect(document.documentElement.hasAttribute("data-native-shell")).toBe(false);
    expect(h.isMaximized).not.toHaveBeenCalled();
  });

  it("无窗口宿主（浏览器 / 自托管 Web）：空操作", () => {
    installWindowFrame(null);

    expect(document.documentElement.hasAttribute("data-native-shell")).toBe(false);
    expect(h.isMaximized).not.toHaveBeenCalled();
  });

  it("读取最大化状态失败只记录，不影响圆角标记", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      h.isMaximized.mockRejectedValue(new Error("ipc down"));

      installWindowFrame();

      expect(document.documentElement.hasAttribute("data-native-shell")).toBe(true);
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("订阅尺寸变化失败只记录，不影响首帧的圆角标记", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      h.onResized.mockRejectedValue(new Error("ipc down"));

      installWindowFrame();

      expect(document.documentElement.hasAttribute("data-native-shell")).toBe(true);
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    } finally {
      errorSpy.mockRestore();
    }
  });
});
