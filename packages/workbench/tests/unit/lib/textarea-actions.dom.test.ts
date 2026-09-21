/**
 * 输入框右键菜单的四个动作。
 *
 * 关键点：插入必须派发 input 事件（v-model 监听的是 input），否则视图与草稿脱节；
 * 剪贴板按运行时分叉（桌面走插件、浏览器走 Web API）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const readText = vi.fn<() => Promise<string>>();
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: () => readText() }));

const copyText = vi.fn<(text: string) => Promise<void>>();
vi.mock("@/lib/clipboard", () => ({ copyText: (text: string) => copyText(text) }));

import { copySelection, cutSelection, hasTextSelection, pasteInto, selectAllText } from "@/lib/textarea-actions";

function makeTextarea(value: string): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  el.value = value;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  setActivePinia(createPinia());
  copyText.mockReset().mockResolvedValue(undefined);
  readText.mockReset().mockResolvedValue("");
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  document.body.innerHTML = "";
});

describe("hasTextSelection", () => {
  it("无选区为 false，选中一段为 true；null 元素为 false", () => {
    const el = makeTextarea("hello");
    expect(hasTextSelection(el)).toBe(false);
    expect(hasTextSelection(null)).toBe(false);
    el.setSelectionRange(1, 3);
    expect(hasTextSelection(el)).toBe(true);
  });
});

describe("copySelection / cutSelection", () => {
  it("复制选区文本", async () => {
    const el = makeTextarea("hello world");
    el.setSelectionRange(0, 5);
    await copySelection(el);
    expect(copyText).toHaveBeenCalledWith("hello");
  });

  it("无选区不写剪贴板", async () => {
    const el = makeTextarea("hello");
    await copySelection(el);
    expect(copyText).not.toHaveBeenCalled();
  });

  it("剪切：先写剪贴板再删掉选区，并派发 input", async () => {
    const el = makeTextarea("hello world");
    el.setSelectionRange(5, 11); // " world"
    const onInput = vi.fn();
    el.addEventListener("input", onInput);

    await cutSelection(el);

    expect(copyText).toHaveBeenCalledWith(" world");
    expect(el.value).toBe("hello");
    expect(onInput).toHaveBeenCalledOnce();
  });
});

describe("pasteInto", () => {
  it("桌面态走插件 readText，插入到光标处并派发 input", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    readText.mockResolvedValue("INSERTED");
    const el = makeTextarea("ab");
    el.setSelectionRange(1, 1);
    const onInput = vi.fn();
    el.addEventListener("input", onInput);

    await pasteInto(el);

    expect(readText).toHaveBeenCalledOnce();
    expect(el.value).toBe("aINSERTEDb");
    expect(onInput).toHaveBeenCalledOnce();
  });

  it("替换选区而不是插入", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    readText.mockResolvedValue("X");
    const el = makeTextarea("abc");
    el.setSelectionRange(0, 3);
    await pasteInto(el);
    expect(el.value).toBe("X");
  });

  it("读剪贴板失败：不抛错，给一条提示", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    readText.mockRejectedValue(new Error("no permission"));
    const el = makeTextarea("ab");
    await expect(pasteInto(el)).resolves.toBeUndefined();
    expect(el.value).toBe("ab");
  });

  it("空剪贴板：不改动内容", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    readText.mockResolvedValue("");
    const el = makeTextarea("ab");
    await pasteInto(el);
    expect(el.value).toBe("ab");
  });
});

describe("selectAllText", () => {
  it("全选（null 元素不抛）", () => {
    const el = makeTextarea("hello");
    selectAllText(el);
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe(5);
    expect(() => selectAllText(null)).not.toThrow();
  });
});
