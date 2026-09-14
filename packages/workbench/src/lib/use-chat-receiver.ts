/**
 * 「本视图能接收对话注入」的一次性接线。
 *
 * 三件事必须一起做，所以合成一个入口：注册接收方（让预览工具条知道这里能收）、
 * 挂附件桥、挂预填桥。
 * - 只注册不挂桥 → 工具条显示可用，点了却没有订阅者，静默失效；
 * - 只挂桥不注册 → 工具条误判为不可用，功能看起来没做。
 * 两种半接线都是「不报错的坏」，所以不给分开调用的机会。
 */
import { onUnmounted, type Ref } from "vue";
import { registerChatReceiver } from "./chat-receiver";
import { useChatTextAttachmentBridge } from "./use-chat-text-attachment";
import { useChatPrefillBridge } from "./use-chat-prefill";
import type { AttachmentsController } from "./use-attachments";

export interface ChatReceiverOptions {
  draft: Ref<string>;
  textarea: Ref<HTMLTextAreaElement | null>;
  attachments: AttachmentsController;
}

export function useChatReceiver(options: ChatReceiverOptions): void {
  const unregister = registerChatReceiver();
  useChatTextAttachmentBridge(options.attachments);
  useChatPrefillBridge(options.draft, options.textarea);
  onUnmounted(unregister);
}
