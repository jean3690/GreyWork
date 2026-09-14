import { nextTick, type Ref } from "vue";

/**
 * 输入框草稿的写入工具。
 *
 * 从 `use-slash-commands.ts` 提取出来，「斜杠命令填充」与「划词预填」共用同一套
 * 「写草稿 + 聚焦 + 光标移到末尾」行为 —— 两处各写一份，迟早会有一处忘了移光标。
 */

/** 聚焦并把光标放到末尾（等一帧，因为调用时节点可能刚被渲染出来）。 */
export function focusTextarea(textarea: Ref<HTMLTextAreaElement | null>): void {
  void nextTick(() => {
    const element = textarea.value;
    if (!element) return;
    element.focus();
    const end = element.value.length;
    element.setSelectionRange(end, end);
  });
}

/**
 * 写草稿并聚焦。
 *
 * `append` 用空行分隔，且**草稿为空时等同 replace**（不留一个开头的空行）。
 * 选用 append 而不是无条件覆盖，是因为用户可能已经写了一半问题 —— 划词预填
 * 不该把它冲掉。
 */
export function fillDraft(
  draft: Ref<string>,
  textarea: Ref<HTMLTextAreaElement | null>,
  text: string,
  mode: "replace" | "append" = "replace",
): void {
  const existing = draft.value.trimEnd();
  draft.value = mode === "append" && existing ? `${existing}\n\n${text}` : text;
  focusTextarea(textarea);
}
