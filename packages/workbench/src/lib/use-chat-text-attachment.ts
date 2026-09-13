/**
 * 把 `chat:attachText` 事件接到输入卡的附件草稿。
 *
 * 与 `usePreviewBridge` 同理：`appEvents` 是模块级单例，订阅要放在组件作用域里，
 * 随组件卸载解绑，否则每个 pinia 实例都会往上再挂一份监听、用例之间互相触发。
 */
import { onUnmounted } from "vue";
import { appEvents } from "../events";
import type { AttachmentsController } from "./use-attachments";

/** 订阅「把现成文本加为附件」（网页正文 → 对话上下文）。 */
export function useChatTextAttachmentBridge(attachments: AttachmentsController): void {
  const dispose = appEvents.on("chat:attachText", ({ name, text, mime }) => {
    attachments.addText({ name, text, mime });
  });
  onUnmounted(dispose);
}
