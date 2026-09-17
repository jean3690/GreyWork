/**
 * 回合活跃判定：本地 LLM 流 / ACP 回合 / ACP 建会话（首段产出来之前的连接窗口）任一在途。
 *
 * 为什么要单独一处：这串判定是四个 store 字段的组合（chat.busy / agent.acpBusy /
 * agent.acpConnecting / agent.acpStatus），原本在对话页、消息行、计划卡、提问卡、
 * 会话状态里各写了一遍 —— 后端每多一个「进行中」状态就要同步改五遍，漏一处就是
 * 一处按钮该禁没禁。收在这里，消费者只关心「现在有没有回合在跑」。
 *
 * 放 lib 而不是 chat store：判定要同时读 chat 与 agent，而 agent 依赖 chat
 * （agent/state.ts 持有 state.chat），把组合塞进 chat store 会形成反向依赖。
 */
import { computed, type ComputedRef } from "vue";
import { useAgentStore } from "../stores/agent";
import { useChatStore } from "../stores/chat";

export function useTurnActive(): ComputedRef<boolean> {
  const chat = useChatStore();
  const agent = useAgentStore();
  return computed(() => chat.busy || agent.acpBusy || agent.acpConnecting || agent.acpStatus === "connecting");
}
