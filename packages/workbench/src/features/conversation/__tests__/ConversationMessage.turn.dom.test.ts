// 回合耗时汇总：assistant 消息回合结束后在时间戳旁给出墙钟总耗时（消息创建 → 最后事件）。
// 流式中不显示——实时秒表由思考段与工具行分工，避免两处重复跳动。
import { describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ConversationMessage from "@/features/conversation/ConversationMessage.vue";
import { i18n } from "@/i18n";
import { useChatStore } from "@/stores/chat";
import type { ThreadMessage } from "@/types";

const T = 1_700_000_000_000;

function mountMessage(message: ThreadMessage) {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(ConversationMessage, { props: { message }, global: { plugins: [pinia, i18n] } });
}

describe("ConversationMessage · 回合耗时", () => {
  it("回合结束：显示消息创建 → 最后事件的总耗时（含思考与工具）", () => {
    const message: ThreadMessage = {
      id: "a1",
      role: "assistant",
      content: "好的",
      ts: T,
      segments: [
        { kind: "thinking", id: "s1", text: "想想", startedAt: T + 100, endedAt: T + 2100 },
        { kind: "text", id: "x1", from: 0, to: null },
      ],
      tools: [
        {
          toolCallId: "t1",
          kind: "execute",
          status: "completed",
          startedAt: T + 2200,
          finishedAt: T + 5200,
          command: "pnpm test",
        },
      ],
    };
    const wrapper = mountMessage(message);
    expect(wrapper.get('[data-testid="message-turn-duration"]').text()).toBe("回合 5.2s");
  });

  it("没有段级事件的消息（纯即时回复）不显示耗时", () => {
    const wrapper = mountMessage({ id: "a2", role: "assistant", content: "嗨", ts: T });
    expect(wrapper.find('[data-testid="message-turn-duration"]').exists()).toBe(false);
  });

  it("用户消息不显示回合耗时（汇总只属于助手回合）", () => {
    const wrapper = mountMessage({ id: "u1", role: "user", content: "在吗", ts: T });
    expect(wrapper.find('[data-testid="message-turn-duration"]').exists()).toBe(false);
  });

  it("流式中不显示（实时秒表由思考段 / 工具行分工）", async () => {
    const wrapper = mountMessage({
      id: "a3",
      role: "assistant",
      content: "生成中",
      ts: T,
      segments: [{ kind: "thinking", id: "s1", text: "想想", startedAt: T + 100, endedAt: T + 2100 }],
    });
    // 未流式时先有静态汇总；再把这条消息标成流式中，汇总撤回（等一拍渲染）
    expect(wrapper.find('[data-testid="message-turn-duration"]').exists()).toBe(true);
    useChatStore().streamingMessageId = "a3";
    await nextTick();
    expect(wrapper.find('[data-testid="message-turn-duration"]').exists()).toBe(false);
  });
});
