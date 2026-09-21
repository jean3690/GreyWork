/**
 * 对话输入框的外观契约。
 *
 * 这两条钉的是「模板这一侧」的约定，机制那一侧（为什么 outline-none 能生效）由
 * `tests/unit/theme/base-css-layers.test.ts` 守着 —— 两边是配对的：
 *
 * 1. 文字区带 `outline-none`：base.css 的全局焦点环（`textarea:focus-visible` → 2px `--accent`
 *    直角描边）不该在文字区上出现，焦点反馈由外层卡片的 `focus-within` 承担。
 *    注意这条曾经是**死代码**：base.css 当时是无层的，无层样式压过 @layer utilities，
 *    所以 `outline-none` 盖不住那条全局规则，点一下就会冒出一个直角蓝框。现在
 *    base.css 的焦点环已挪进 `@layer base`，这条才真正生效。
 * 2. 文字区自己带一块可见的圆角底面（不再是 `bg-transparent` 的隐形区域），
 *    这样外层卡片才是「输入框」本体、内层是一块写字的凹槽，圆角才有东西可依附。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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

async function mountComposer() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = useSessionStore().createSession(null, "输入框外观测试");
  const router = createAppRouter();
  await router.push(`/conversation/${session.id}`);
  await router.isReady();
  return mount(ConversationView, { global: { plugins: [pinia, i18n, router] } });
}

beforeEach(() => {
  localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("对话输入框外观", () => {
  it("文字区不吃默认焦点环 —— 焦点反馈交给外层卡片", async () => {
    const wrapper = await mountComposer();

    expect(wrapper.get('textarea[aria-label="发送消息"]').classes()).toContain("outline-none");
  });

  it("文字区自带圆角与可见底面，不再是透明无边框的隐形区域", async () => {
    const wrapper = await mountComposer();
    const classes = wrapper.get('textarea[aria-label="发送消息"]').classes();

    expect(classes.some((name) => name.startsWith("rounded-"))).toBe(true);
    expect(classes).not.toContain("bg-transparent");
  });
});
