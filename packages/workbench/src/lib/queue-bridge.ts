/**
 * 命令队列 → 统一分流点的应用级桥接。
 *
 * 队列切片只负责「列表」：入队 / 移除 / 何时出队。它不认识 ACP、也不认识本地 LLM。
 * 「这条待发指令发给谁」的知识只有一处 —— `dispatchIntent`。但队列的补发发生在
 * store 内部（busy 归零的 watch 里），而 store 直接 import dispatchIntent 会成环
 * （dispatch-intent → useChatStore → queue 切片），所以由外壳在组件作用域里把
 * dispatchIntent 注入进去，与 preview-bridge 同一条思路。
 *
 * 不注入时队列回落 `submitText`（本地 LLM 管线）：这是给单测与纯本地场景留的退路，
 * 真实外壳必须挂上本桥，否则 ACP 会话里的待发指令会被错误地送进本地 LLM。
 */
import { onUnmounted } from "vue";
import { useChatStore } from "../stores/chat";
import { dispatchIntent } from "./dispatch-intent";

export function useQueueBridge(): void {
  const chat = useChatStore();
  // 与对话页发送同一套语义：待发指令也是用户意图，同样过计划门、同样允许编排判定。
  chat.setQueueDispatch((input, attachments, comments) => {
    void dispatchIntent(input, attachments, { planGate: true, allowOrchestrate: true, comments });
  });

  onUnmounted(() => {
    chat.setQueueDispatch(null);
  });
}
