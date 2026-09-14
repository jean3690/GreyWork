/**
 * 剪贴板写入的运行时分叉。
 *
 * **桌面必须走插件、浏览器必须走 Web API** —— 两个分支各自可靠、互相不可用：
 * Tauri 的 WebKit WebView 上 Web API 静默丢字（这正是 lint 规则禁止它的原因），
 * 而浏览器态没有 IPC 宿主、插件必然失败。两条路都要有用例。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ writeText: vi.fn(() => Promise.resolve()) }));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: h.writeText }));

import { copyText } from "@/lib/clipboard";

function enableTauri(value: boolean): void {
  if (value) (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  else delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

function stubWebClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
}

const ORIGINAL_CLIPBOARD = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");

beforeEach(() => {
  h.writeText.mockClear();
});

afterEach(() => {
  // 桌面态用例不碰 navigator.clipboard；浏览器态用例挂上的桩要拆掉，别污染后续用例
  if (ORIGINAL_CLIPBOARD) Object.defineProperty(navigator, "clipboard", ORIGINAL_CLIPBOARD);
  else delete (navigator as unknown as Record<string, unknown>).clipboard;
});

describe("copyText", () => {
  it("桌面走插件（Web API 在 WKWebView / WebKitGTK 上静默丢字）", async () => {
    enableTauri(true);
    stubWebClipboard(vi.fn(() => Promise.resolve()));

    await copyText("要复制的内容");

    expect(h.writeText).toHaveBeenCalledWith("要复制的内容");
  });

  it("浏览器走 Web API（没有 IPC 宿主，插件必然失败）", async () => {
    enableTauri(false);
    const writeText = vi.fn(() => Promise.resolve());
    stubWebClipboard(writeText);

    await copyText("浏览器内容");

    expect(writeText).toHaveBeenCalledWith("浏览器内容");
    expect(h.writeText).not.toHaveBeenCalled();
  });

  it("桌面下 Web API 即使被 stub 也不该被碰（防止有人顺手加回退）", async () => {
    enableTauri(true);
    const writeText = vi.fn(() => Promise.resolve());
    stubWebClipboard(writeText);

    await copyText("桌面内容");

    expect(writeText).not.toHaveBeenCalled();
  });
});
