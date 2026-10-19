// 空会话引导：建议卡点击只把文本填进草稿（不发送），并回焦输入框。
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { Attachment } from "@/types";

vi.mock("@/state/attachment-library", () => ({
  pickAttachments: () => Promise.resolve([] as Attachment[]),
  attachmentsFromFiles: () => Promise.resolve([] as Attachment[]),
  attachmentsFromPaths: () => Promise.resolve([] as Attachment[]),
  attachmentsFromClipboard: () => Promise.resolve([]),
  materializeAttachments: (_sessionId: string, items: readonly Attachment[]) => Promise.resolve([...items]),
  readAttachmentBase64: () => Promise.resolve("QUJD"),
  readAttachmentText: () => Promise.resolve({ text: "x", truncated: false }),
  attachmentObjectUrl: () => Promise.resolve(null),
  releaseAttachmentObjectUrls: () => undefined,
}));

vi.mock("@greywork/acp", () => ({
  createAcpClient: () => ({
    isAvailable: () => true,
    startAgent: () => Promise.resolve(),
    openSession: () => Promise.resolve(),
    setSessionConfig: () => Promise.resolve([]),
    setPermissionTier: () => Promise.resolve(),
    prompt: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    respondPermission: () => Promise.resolve(),
    onEvent: () => Promise.resolve(() => undefined),
  }),
  desktopHomeDir: () => Promise.resolve("/home/test"),
}));

import ConversationView from "@/features/conversation/ConversationView.vue";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";
import { useSessionStore } from "@/stores/session";
import { useChatStore } from "@/stores/chat";

async function mountEmptyThread() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = useSessionStore().createSession(null, "建议卡测试");
  const router = createAppRouter();
  await router.push(`/conversation/${session.id}`);
  await router.isReady();
  const wrapper = mount(ConversationView, { global: { plugins: [pinia, i18n, router] } });
  return { wrapper, chat: useChatStore() };
}

describe("空会话建议卡", () => {
  it("空会话渲染 4 张建议卡", async () => {
    const { wrapper } = await mountEmptyThread();
    expect(wrapper.findAll('[data-testid="composer-suggestion"]')).toHaveLength(4);
  });

  it("点建议卡把文案填进草稿，但不发送（消息流仍为空、不派发）", async () => {
    const { wrapper, chat } = await mountEmptyThread();
    const spy = vi.spyOn(chat, "enqueueCommand");

    await wrapper.findAll('[data-testid="composer-suggestion"]')[0].trigger("click");

    const draft = (wrapper.get('textarea[aria-label="发送消息"]').element as HTMLTextAreaElement).value;
    expect(draft).toBe(i18n.global.t("chat.composer.suggest.exploreText"));
    expect(draft.length).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="message-actions"]').exists()).toBe(false);
  });
});
