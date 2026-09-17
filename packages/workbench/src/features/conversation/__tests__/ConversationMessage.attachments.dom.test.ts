// 已发送消息里的附件渲染：图片出缩略图、文本出 chip，点击按来源开预览。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { Attachment, ThreadMessage } from "@/types";

const h = vi.hoisted(() => ({
  attachmentObjectUrl: vi.fn<(item: Attachment) => Promise<string | null>>(),
}));

vi.mock("@/state/attachment-library", () => ({
  attachmentObjectUrl: (item: Attachment) => h.attachmentObjectUrl(item),
  readAttachmentBase64: () => Promise.resolve(""),
  readAttachmentText: () => Promise.resolve({ text: "", truncated: false }),
  releaseAttachmentObjectUrls: () => undefined,
}));

import ConversationMessage from "@/features/conversation/ConversationMessage.vue";
import { i18n } from "@/i18n";
import { usePreviewStore } from "@/stores/preview";

const image: Attachment = { id: "a1", kind: "image", name: "shot.png", mime: "image/png", size: 4, path: "/tmp/shot.png" };
const textFile: Attachment = { id: "a2", kind: "text", name: "notes.md", mime: "text/markdown", size: 12, path: "/tmp/notes.md" };

function userMessage(attachments: Attachment[]): ThreadMessage {
  return { id: "m1", role: "user", content: "看看这些", ts: 1_700_000_000_000, attachments };
}

function mountMessage(message: ThreadMessage) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const preview = usePreviewStore();
  const open = vi.spyOn(preview, "open");
  const wrapper = mount(ConversationMessage, { props: { message }, global: { plugins: [pinia, i18n] } });
  return { wrapper, open };
}

beforeEach(() => {
  h.attachmentObjectUrl.mockReset();
  h.attachmentObjectUrl.mockImplementation(() => Promise.resolve("blob:preview"));
});

describe("ConversationMessage · 附件", () => {
  it("图片出缩略图、文本出文件名 chip", async () => {
    const { wrapper } = mountMessage(userMessage([image, textFile]));
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="message-attachment-image"]').exists()).toBe(true);
    });
    expect(wrapper.get('[data-testid="message-attachment-image"] img').attributes("src")).toBe("blob:preview");
    expect(wrapper.get('[data-testid="message-attachment-file"]').text()).toContain("notes.md");
    expect(wrapper.find('[data-testid="message-attachments"]').exists()).toBe(true);
  });

  it("点附件按磁盘源开预览面板（桌面态）", async () => {
    const { wrapper, open } = mountMessage(userMessage([image, textFile]));
    await vi.waitFor(() => expect(wrapper.find('[data-testid="message-attachment-image"]').exists()).toBe(true));

    await wrapper.get('[data-testid="message-attachment-image"]').trigger("click");
    expect(open).toHaveBeenCalledWith("/tmp/shot.png", "shot.png", "disk");

    await wrapper.get('[data-testid="message-attachment-file"]').trigger("click");
    expect(open).toHaveBeenCalledWith("/tmp/notes.md", "notes.md", "disk");
  });

  it("缩略图读不到（文件被移走）时退化为占位，不抛错", async () => {
    h.attachmentObjectUrl.mockResolvedValue(null);
    const { wrapper } = mountMessage(userMessage([image]));
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="message-attachment-image"]').text()).toContain("附件已不可用");
    });
  });

  it("没有附件的消息不渲染附件区", () => {
    const { wrapper } = mountMessage({ id: "m2", role: "user", content: "纯文本", ts: 1 });
    expect(wrapper.find('[data-testid="message-attachments"]').exists()).toBe(false);
  });

  it("只发附件（无正文）时不渲染空段落", async () => {
    const { wrapper } = mountMessage({ id: "m3", role: "user", content: "", ts: 1, attachments: [image] });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="message-attachment-image"]').exists()).toBe(true));
    expect(wrapper.find(".msg__bubble p").exists()).toBe(false);
  });
});
