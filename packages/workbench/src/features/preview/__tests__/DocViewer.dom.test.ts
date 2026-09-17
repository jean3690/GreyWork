/**
 * docx 预览（DocViewer）：二进制读取 → parseDocx → 段落块/表格计数 + 状态归零。
 * 用 jszip 在测试里现拼最小 docx（段落 / 表格 / 空正文 / 垃圾字节），不依赖落盘 fixture。
 * 「代次自增放弃旧解析」也顺带覆盖：连续换内容时旧结果不能画上来。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import JSZip from "jszip";

import type { PreviewTab } from "@/stores/preview";

const h = vi.hoisted(() => ({ readBinary: vi.fn<(path: string) => Promise<Uint8Array>>() }));
vi.mock("@/stores/vfs", () => ({ useVfsStore: () => ({ readBinary: h.readBinary }) }));

import DocViewer from "@/features/preview/DocViewer.vue";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";

async function buildDocx(body: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:a="${A}" xmlns:wp="${WP}"><w:body>${body}</w:body></w:document>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
  );
  return await zip.generateAsync({ type: "uint8array" });
}

function tab(partial: Partial<PreviewTab> = {}): PreviewTab {
  return { id: "pv-1", path: "out/说明.docx", name: "说明.docx", kind: "docx", source: "vfs", revision: 0, ...partial };
}

function mountViewer(overrides?: Partial<PreviewTab>) {
  return mount(DocViewer, { props: { tab: tab(overrides) } });
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  h.readBinary.mockReset();
});

/** JSZip 内部按 setTimeout 分片，flushPromises（纯微任务）喂不到，需等一个真实宏任务。 */
async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 40));
}

describe("DocViewer", () => {
  it("读取中：加载占位", () => {
    h.readBinary.mockReturnValue(new Promise(() => {}));
    expect(mountViewer().text()).toContain("读取中");
  });

  it("读取失败：alert + 错误文案", async () => {
    h.readBinary.mockRejectedValue(new Error("boom"));
    const wrapper = mountViewer();
    await settle();
    expect(wrapper.get('[role="alert"]').text()).toContain("读取失败：boom");
  });

  it("解析成功：计数栏表达段落块，正文渲染出文字", async () => {
    h.readBinary.mockResolvedValue(await buildDocx("<w:p><w:r><w:t>你好，世界</w:t></w:r></w:p>"));
    const wrapper = mountViewer();
    await settle();

    expect(wrapper.text()).toContain("1 个段落块");
    expect(wrapper.get('[data-testid="doc-viewer"]').text()).toContain("你好，世界");
  });

  it("含表格：计数栏追加表格数目", async () => {
    const body =
      "<w:p><w:r><w:t>表前段落</w:t></w:r></w:p>" + "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>单元格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>";
    h.readBinary.mockResolvedValue(await buildDocx(body));
    const wrapper = mountViewer();
    await settle();

    expect(wrapper.text()).toContain("2 个段落块 · 1 张表格");
  });

  it("空正文：给出提示而不是裸白", async () => {
    h.readBinary.mockResolvedValue(await buildDocx(""));
    const wrapper = mountViewer();
    await settle();

    expect(wrapper.text()).toContain("这份文档没有正文内容。");
  });

  it("解析失败（垃圾字节）：parseError 状态，不进白屏", async () => {
    h.readBinary.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    const wrapper = mountViewer();
    await settle();

    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toContain("无法解析该文档");
  });

  it("从有文档切到无正文的新内容：计数与正文状态一起归零（代次正确性）", async () => {
    const first = await buildDocx("<w:p><w:r><w:t>初稿</w:t></w:r></w:p>");
    const second = await buildDocx("");
    h.readBinary.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const wrapper = mountViewer();
    await settle();
    expect(wrapper.text()).toContain("1 个段落块");

    await wrapper.setProps({ tab: tab({ revision: 1 }) });
    await settle();

    expect(wrapper.text()).toContain("这份文档没有正文内容。");
    expect(wrapper.text()).not.toContain("初稿");
  });
});
