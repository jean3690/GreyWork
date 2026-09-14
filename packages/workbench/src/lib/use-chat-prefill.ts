/**
 * 把 `chat:prefill` 事件接到输入框草稿。
 *
 * 与 `use-chat-text-attachment.ts` 同构：`appEvents` 是模块级单例，订阅必须放在组件
 * 作用域里随卸载解绑，否则用例之间会互相触发。
 */
import { onUnmounted, type Ref } from "vue";
import { appEvents } from "../events";
import { fillDraft } from "./composer-draft";

/** 订阅「预填输入框并聚焦」（预览划词 → 问 AI / 解释 / 改写）。 */
export function useChatPrefillBridge(draft: Ref<string>, textarea: Ref<HTMLTextAreaElement | null>): void {
  const dispose = appEvents.on("chat:prefill", ({ text, mode }) => {
    fillDraft(draft, textarea, text, mode ?? "replace");
  });
  onUnmounted(dispose);
}
