<script setup lang="ts">
/**
 * 流式纯文本渲染：增量 append 到 textContent，绕开 Vue vnode diff 与
 * Markdown 全量重解析。仅用于流式中间态；流结束后由外层切回 MarkdownText。
 *
 * 尾部光标（.msg__caret）是 host 的常驻末子元素：文本增量统一 insertBefore 到它
 * 之前，光标就恒跟在最后一个字符后面，并随文本自然换行。它由 Vue 托管（真 DOM
 * 元素、可加 data-testid），比 ::after 可测；整段重绘时也只清文本节点，不碰它。
 */
import { onMounted, ref, watch } from "vue";

const props = defineProps<{ content: string }>();

const host = ref<HTMLElement | null>(null);
const caret = ref<HTMLElement | null>(null);
let lastLen = 0;

function appendText(text: string): void {
  const el = host.value;
  if (!el) return;
  const node = document.createTextNode(text);
  // 光标在就插到它前面；不在（异常兜底）才直接追加。
  if (caret.value) el.insertBefore(node, caret.value);
  else el.appendChild(node);
}

/** 只摘文本节点：直接清 textContent 会把 Vue 托管的光标子元素一起抹掉。 */
function clearText(): void {
  const el = host.value;
  if (!el) return;
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) el.removeChild(node);
  }
}

function paintFull(text: string): void {
  if (!host.value) return;
  clearText();
  appendText(text);
  lastLen = text.length;
}

onMounted(() => paintFull(props.content));

watch(
  () => props.content,
  (value) => {
    if (!host.value) return;
    // 内容被整体替换（错误回退等）：重绘而非追加。
    if (value.length < lastLen) {
      paintFull(value);
      return;
    }
    const delta = value.slice(lastLen);
    if (delta) appendText(delta);
    lastLen = value.length;
  },
  { flush: "sync" },
);
</script>

<template>
  <div ref="host" class="msg__stream msg__text m-0 text-foreground text-[13.5px] leading-[1.75]">
    <!-- aria-hidden：光标对读屏是噪音，正文由 host 的文本节点承载。 -->
    <span ref="caret" class="msg__caret" data-testid="stream-caret" aria-hidden="true"></span>
  </div>
</template>
