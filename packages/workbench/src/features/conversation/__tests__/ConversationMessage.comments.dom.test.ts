// 选区评论注解接线（U4）：带 comments 的用户消息渲染引用注解，无 comments 不渲染。
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { ThreadMessage } from "@/types";

vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal()),
  invoke: vi.fn(),
}));
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

describe("ConversationMessage · 选区评论注解", () => {
  it("带 comments 的用户消息渲染注解（引用 + 来源）", () => {
    const wrapper = mountMessage({
      id: "m1",
      role: "user",
      content: "这里要改",
      ts: 1_700_000_000_000,
      comments: [{ id: "c1", quote: "被引用的原句", note: "这里要改", source: "report.md", createdAt: 1 }],
    });
    expect(wrapper.find('[data-testid="message-comments"]').exists()).toBe(true);
    const item = wrapper.get('[data-testid="message-comment"]');
    expect(item.text()).toContain("被引用的原句");
    expect(item.text()).toContain("report.md");
  });

  it("无 comments 不渲染注解区", () => {
    const wrapper = mountMessage({ id: "m2", role: "user", content: "纯文本", ts: 1_700_000_000_000 });
    expect(wrapper.find('[data-testid="message-comments"]').exists()).toBe(false);
  });
});
