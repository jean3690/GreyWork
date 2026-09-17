// 消息流里的 AskUserQuestion 卡片接线：带 ask 载荷的助手消息要渲染出选择卡。
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

describe("ConversationMessage · AskUserQuestion", () => {
  it("带 ask 的助手消息渲染选择卡", () => {
    const message: ThreadMessage = {
      id: "m1",
      role: "assistant",
      content: "",
      ts: 1_700_000_000_000,
      ask: { questions: [{ question: "继续吗？", options: [{ label: "继续" }, { label: "停止" }] }] },
    };
    const wrapper = mountMessage(message);
    expect(wrapper.find('[data-testid="ask-card"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="ask-option-0"]')).toHaveLength(2);
  });

  it("没有 ask 的消息不渲染选择卡", () => {
    const wrapper = mountMessage({ id: "m2", role: "assistant", content: "普通回复", ts: 1_700_000_000_000 });
    expect(wrapper.find('[data-testid="ask-card"]').exists()).toBe(false);
  });
});
