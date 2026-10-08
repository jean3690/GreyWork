/**
 * 把 `chat:comment` 事件接到输入卡的评论草稿。
 *
 * 一条评论同时做两件事：
 * - **批注**：把 `{ quote, note }` 记进评论草稿，发送时挂到消息上渲染为注解（回看可见）；
 * - **正文**：批注文本追加进输入框草稿 —— 批注就是用户要说的话，模型据此回应，
 *   而注解里展示的是被评论的原文片段（避免同一句话在气泡与注解里出现两遍）。
 *
 * 与 `useChatTextAttachmentBridge` 同理：`appEvents` 是模块级单例，订阅要放在组件作用域里，
 * 随组件卸载解绑，否则每个 pinia 实例都会往上再挂一份监听、用例之间互相触发。
 */
import { createIdFactory } from "@greywork/core";
import { onUnmounted, type Ref } from "vue";
import { fillDraft } from "./composer-draft";
import { appEvents } from "../events";
import type { MessageComment } from "../types";

const uid = createIdFactory("cm");

/** 订阅「把选中一段 + 批注加为选区评论」。空批注忽略（评论必须有内容）。 */
export function useChatCommentBridge(comments: Ref<MessageComment[]>, draft: Ref<string>, textarea: Ref<HTMLTextAreaElement | null>): void {
  const dispose = appEvents.on("chat:comment", ({ quote, note, source }) => {
    const trimmed = note.trim();
    if (!trimmed) return;
    comments.value = [...comments.value, { id: uid(), quote, note: trimmed, source, createdAt: Date.now() }];
    fillDraft(draft, textarea, trimmed, "append");
  });
  onUnmounted(dispose);
}
