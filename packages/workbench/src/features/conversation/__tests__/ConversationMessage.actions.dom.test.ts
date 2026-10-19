// 消息 hover 操作条：复制（两种角色都有）+ 回退（仅带快照的用户消息），回退事件交回宿主。
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { ThreadMessage } from "@/types";

const h = vi.hoisted(() => ({ writeText: vi.fn<(text: string) => Promise<void>>() }));

vi.mock("@/lib/clipboard", () => ({ copyText: (text: string) => h.writeText(text) }));

import ConversationMessage from "@/features/conversation/ConversationMessage.vue";
import { i18n } from "@/i18n";

function mountMessage(message: ThreadMessage) {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(ConversationMessage, { props: { message }, global: { plugins: [pinia, i18n] } });
}

const userMsg: ThreadMessage = { id: "u1", role: "user", content: "改一下这段", ts: 1_700_000_000_000 };
const userWithSnapshot: ThreadMessage = { ...userMsg, id: "u2", snapshotRef: "snap-1" };
const assistantMsg: ThreadMessage = { id: "a1", role: "assistant", content: "已改好", ts: 1_700_000_001_000 };

describe("ConversationMessage · 操作条", () => {
  it("user 与 assistant 都渲染复制键，回退键都不出现（无快照）", () => {
    const user = mountMessage(userMsg);
    expect(user.findAll('[data-testid="message-copy"]')).toHaveLength(1);
    expect(user.find('[data-testid="message-rewind"]').exists()).toBe(false);

    const assistant = mountMessage(assistantMsg);
    expect(assistant.findAll('[data-testid="message-copy"]')).toHaveLength(1);
    expect(assistant.find('[data-testid="message-rewind"]').exists()).toBe(false);
  });

  it("带回合起点快照的用户消息出现回退键，assistant 即便有快照也不出（回退语义只属于用户回合起点）", () => {
    const withSnap = mountMessage(userWithSnapshot);
    expect(withSnap.find('[data-testid="message-rewind"]').exists()).toBe(true);

    const assistant = mountMessage({ ...assistantMsg, snapshotRef: "snap-2" });
    expect(assistant.find('[data-testid="message-rewind"]').exists()).toBe(false);
  });

  it("点复制把正文交给剪贴板，并把图标翻成对勾（1.5s 后回落）", async () => {
    h.writeText.mockResolvedValue(undefined);
    // 计时器先切假：回退计时（1.5s）在点击时就排下了，事后才切假就推不动它。
    vi.useFakeTimers();
    const wrapper = mountMessage(assistantMsg);

    const pathOf = () => wrapper.get('[data-testid="message-copy"] svg path').attributes("d");
    const copyGlyph = pathOf();
    await wrapper.get('[data-testid="message-copy"]').trigger("click");
    // copyText 是 promise，flush 一轮微任务让 copied 翻真（waitFor 在 fake timers 下会挂住）
    await vi.advanceTimersByTimeAsync(0);
    expect(pathOf()).not.toBe(copyGlyph);

    expect(h.writeText).toHaveBeenCalledWith("已改好");

    await vi.advanceTimersByTimeAsync(1_600);
    expect(pathOf()).toBe(copyGlyph);
    vi.useRealTimers();
  });

  it("空正文的消息不渲染操作条（没有可复制的东西）", () => {
    const wrapper = mountMessage({ id: "e1", role: "assistant", content: "", ts: 1 });
    expect(wrapper.find('[data-testid="message-actions"]').exists()).toBe(false);
  });

  it("点回退把消息抛给宿主（ConversationView 据此挂确认弹层）", async () => {
    const wrapper = mountMessage(userWithSnapshot);
    await wrapper.get('[data-testid="message-rewind"]').trigger("click");
    const emitted = wrapper.emitted("rewind");
    expect(emitted).toHaveLength(1);
    expect(emitted?.[0]).toEqual([userWithSnapshot]);
  });
});
