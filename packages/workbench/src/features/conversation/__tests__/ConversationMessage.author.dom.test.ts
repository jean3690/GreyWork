// 消息作者行接线（U1）：设了 authorId 才渲染头像 + 名，点击回传作者键给群聊时间线。
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { ThreadMessage } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@greywork/acp", () => ({
  createAcpClient: () => ({ isAvailable: () => true, onEvent: () => Promise.resolve(() => undefined) }) as never,
  desktopHomeDir: () => Promise.resolve("/home/test"),
}));

import ConversationMessage from "@/features/conversation/ConversationMessage.vue";
import { i18n } from "@/i18n";

function mountMessage(message: ThreadMessage) {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(ConversationMessage, { props: { message }, global: { plugins: [pinia, i18n] } });
}

describe("ConversationMessage · 作者行", () => {
  it("设了 authorId 才渲染作者行，并显示作者名", () => {
    const wrapper = mountMessage({
      id: "m1",
      role: "assistant",
      content: "先拆解一下。",
      ts: 1_700_000_000_000,
      authorId: "slot-1",
      authorName: "Leader",
    });
    const author = wrapper.find('[data-testid="message-author"]');
    expect(author.exists()).toBe(true);
    expect(author.text()).toContain("Leader");
  });

  it("未设 authorId 的普通消息不渲染作者行", () => {
    const wrapper = mountMessage({ id: "m2", role: "assistant", content: "普通回复", ts: 1_700_000_000_000 });
    expect(wrapper.find('[data-testid="message-author"]').exists()).toBe(false);
  });

  it("点作者行回传作者键", async () => {
    const wrapper = mountMessage({
      id: "m3",
      role: "assistant",
      content: "hi",
      ts: 1_700_000_000_000,
      authorId: "slot-2",
      authorName: "Builder",
    });
    await wrapper.find('[data-testid="message-author"]').trigger("click");
    expect(wrapper.emitted("authorClick")?.[0]).toEqual(["slot-2"]);
  });
});
