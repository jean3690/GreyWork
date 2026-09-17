/**
 * 老格式 viewer 的契约：**把「不支持」说清楚，而不是把二进制当文本渲染出来**。
 *
 * 这是回归护栏 —— 在这之前 .doc 落到 `raw`，被 TextViewer 按 utf-8 读，屏幕上是一片乱码
 * 且没有任何错误提示，用户只能以为文件坏了。所以每条用例都同时断言
 * 「提示出现」和「原始字节没有出现在界面上」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import LegacyOfficeViewer from "@/features/preview/LegacyOfficeViewer.vue";
import { usePreviewStore } from "@/stores/preview";
import { useVfsStore } from "@/stores/vfs";
import type { PreviewTab } from "@/stores/preview";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

/** 出现在字节里、绝不该被渲染出来的哨兵串。 */
const MARKER = "SHOULD_NEVER_RENDER";

/** OLE2 复合文档头，即真·.doc/.xls/.ppt。 */
const OLE2_HEAD = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** ZIP 本地文件头。 */
const ZIP_HEAD = [0x50, 0x4b, 0x03, 0x04];

function bytes(...parts: Array<number[] | string>): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") for (const char of part) out.push(char.charCodeAt(0) & 0xff);
    else out.push(...part);
  }
  return new Uint8Array(out);
}

function tabOf(id: string): PreviewTab {
  const tab = usePreviewStore().tabs.find((candidate) => candidate.id === id);
  if (!tab) throw new Error("tab 未登记");
  return tab;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe("LegacyOfficeViewer", () => {
  it("真 OLE2 老格式：明确说不支持，且不把字节渲染成乱码", async () => {
    const vfs = useVfsStore();
    await vfs.writeBinary("docs/legacy.doc", bytes(OLE2_HEAD, MARKER));
    const id = usePreviewStore().open("docs/legacy.doc");
    expect(tabOf(id).kind).toBe("legacy-office");

    const wrapper = mount(LegacyOfficeViewer, { props: { tab: tabOf(id) } });
    await flushPromises();

    expect(wrapper.find('[data-testid="legacy-office-viewer"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("不支持预览 .doc 老格式");
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    // 关键回归断言：字节内容不得出现在界面上。
    expect(wrapper.text()).not.toContain(MARKER);
  });

  it("扩展名被改错的 OOXML：给出可操作的改名提示，而不是笼统说不支持", async () => {
    const vfs = useVfsStore();
    await vfs.writeBinary("docs/mislabeled.doc", bytes(ZIP_HEAD, "word/document.xml"));
    const id = usePreviewStore().open("docs/mislabeled.doc");

    const wrapper = mount(LegacyOfficeViewer, { props: { tab: tabOf(id) } });
    await flushPromises();

    expect(wrapper.text()).toContain("这个文件其实是 .docx");
    expect(wrapper.text()).toContain("改名成 .docx");
    // 内容其实渲染得了，工具条与正文都不能说「不支持预览」，否则自相矛盾。
    expect(wrapper.text()).not.toContain("不支持预览");
    expect(wrapper.text()).toContain("实为 .docx");
    // 改名就能看，不必绕道系统应用。
    expect(wrapper.text()).not.toContain("用系统应用打开");
  });

  it("ZIP 但认不出具体格式：如实说认不出，不硬猜", async () => {
    const vfs = useVfsStore();
    await vfs.writeBinary("docs/mystery.xls", bytes(ZIP_HEAD, "unrelated/entry.xml"));
    const id = usePreviewStore().open("docs/mystery.xls");

    const wrapper = mount(LegacyOfficeViewer, { props: { tab: tabOf(id) } });
    await flushPromises();

    expect(wrapper.text()).toContain("认不出这个文件的具体格式");
  });

  it("读取失败：显示 role=alert，不白屏", async () => {
    const id = usePreviewStore().open("docs/missing.doc");
    const wrapper = mount(LegacyOfficeViewer, { props: { tab: tabOf(id) } });
    await flushPromises();

    const alert = wrapper.find('[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain("读取失败");
  });
});

describe("LegacyOfficeViewer 降级体验", () => {
  /** 桌面态标记：`isTauriRuntime()` 认 window 上的 `__TAURI_INTERNALS__`。 */
  function stubTauriRuntime(): void {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  }

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    invokeMock.mockReset();
  });

  it("摘要条显示文件体积（byteLength 换算，无需宿主 stat）", async () => {
    const vfs = useVfsStore();
    await vfs.writeBinary("docs/legacy.doc", bytes(OLE2_HEAD, MARKER));
    const id = usePreviewStore().open("docs/legacy.doc");

    const wrapper = mount(LegacyOfficeViewer, { props: { tab: tabOf(id) } });
    await flushPromises();

    // OLE2 头 8 字节 + 哨兵串 19 字节 = 27 B
    expect(wrapper.text()).toContain("27 B");
  });

  it("桌面态且有磁盘孪生路径：正文里出现「用系统应用打开」按钮，点击调 open_path", async () => {
    stubTauriRuntime();
    invokeMock.mockResolvedValue(undefined);
    const preview = usePreviewStore();
    const id = preview.open("docs/legacy.doc");
    preview.attachDiskPath("docs/legacy.doc", "/home/u/docs/legacy.doc");

    const wrapper = mount(LegacyOfficeViewer, { props: { tab: tabOf(id) } });
    await flushPromises();

    expect(wrapper.find('[data-testid="legacy-office-open-external"]').exists()).toBe(true);
    await wrapper.get('[data-testid="legacy-office-open-external"]').trigger("click");
    await flushPromises();
    expect(invokeMock).toHaveBeenCalledWith("open_path", { path: "/home/u/docs/legacy.doc" });
  });

  it("浏览器态没有磁盘通道：按钮不出现", async () => {
    const vfs = useVfsStore();
    await vfs.writeBinary("docs/legacy.doc", bytes(OLE2_HEAD));
    const id = usePreviewStore().open("docs/legacy.doc");

    const wrapper = mount(LegacyOfficeViewer, { props: { tab: tabOf(id) } });
    await flushPromises();

    expect(wrapper.find('[data-testid="legacy-office-open-external"]').exists()).toBe(false);
    // 提示文案还在，只是不再指向一个不存在的按钮
    expect(wrapper.text()).toContain("用系统应用打开");
  });

  it("OLE2 老格式给出另存为新格式的转换提示", async () => {
    const vfs = useVfsStore();
    await vfs.writeBinary("docs/legacy.xls", bytes(OLE2_HEAD));
    const id = usePreviewStore().open("docs/legacy.xls");

    const wrapper = mount(LegacyOfficeViewer, { props: { tab: tabOf(id) } });
    await flushPromises();

    expect(wrapper.text()).toContain("另存为对应的 .docx / .xlsx / .pptx 新格式");
  });
});
