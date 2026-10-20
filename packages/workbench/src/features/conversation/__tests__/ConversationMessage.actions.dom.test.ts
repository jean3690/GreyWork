// 消息 hover 操作条：复制（两种角色都有）+ 回退（仅带快照的用户消息），回退事件交回宿主。
import { describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { ThreadMessage } from "@/types";

const h = vi.hoisted(() => ({ writeText: vi.fn<(text: string) => Promise<void>>() }));

vi.mock("@/lib/clipboard", () => ({ copyText: (text: string) => h.writeText(text) }));

import ConversationMessage from "@/features/conversation/ConversationMessage.vue";
import { i18n } from "@/i18n";
import { useChatStore } from "@/stores/chat";

function mountMessage(message: ThreadMessage, props: { isLast?: boolean } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(ConversationMessage, { props: { message, ...props }, global: { plugins: [pinia, i18n] } });
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

describe("ConversationMessage · 消息操作（编辑 / 重新生成 / 删除）", () => {
  it("user 消息给编辑键（不要求快照），并渲染时间戳", () => {
    const wrapper = mountMessage(userMsg);
    expect(wrapper.find('[data-testid="message-edit"]').exists()).toBe(true);
    // 与 assistant 末行同一格式：HH:MM
    expect(wrapper.text()).toMatch(/\d{2}:\d{2}/);
  });

  it("assistant 非末条：没有重新生成 / 删除（这两动会截掉其后全部）", () => {
    const wrapper = mountMessage(assistantMsg);
    expect(wrapper.find('[data-testid="message-edit"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="message-regenerate"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="message-delete"]').exists()).toBe(false);
  });

  it("assistant 末条且空闲：重新生成 / 删除都在，点哪键抛哪条消息", async () => {
    const wrapper = mountMessage(assistantMsg, { isLast: true });
    await wrapper.get('[data-testid="message-regenerate"]').trigger("click");
    await wrapper.get('[data-testid="message-delete"]').trigger("click");
    expect(wrapper.emitted("regenerate")?.[0]).toEqual([assistantMsg]);
    expect(wrapper.emitted("delete")?.[0]).toEqual([assistantMsg]);
  });

  it("回合进行中：编辑 / 重新生成 / 删除全部收起（prepareResend 有忙闸，不做无谓入口）", async () => {
    const wrapper = mountMessage(assistantMsg, { isLast: true });
    // 先挂载（建好自己的 pinia）再把会话标成忙碌
    useChatStore().busy = true;
    await nextTick();
    expect(wrapper.find('[data-testid="message-regenerate"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="message-delete"]').exists()).toBe(false);
  });

  it("空回复的末条 assistant 也留操作条（回合白跑一场，要能重生成 / 删掉）", () => {
    const wrapper = mountMessage({ id: "e2", role: "assistant", content: "", ts: 1 }, { isLast: true });
    expect(wrapper.find('[data-testid="message-actions"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="message-regenerate"]').exists()).toBe(true);
  });

  it("点编辑把消息抛给宿主（草稿回填由 ConversationView 做）", async () => {
    const wrapper = mountMessage(userMsg);
    await wrapper.get('[data-testid="message-edit"]').trigger("click");
    expect(wrapper.emitted("edit")?.[0]).toEqual([userMsg]);
  });
});
