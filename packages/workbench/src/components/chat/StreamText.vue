<script setup lang="ts">
import { onMounted, ref, watch } from "vue";

/**
 * 流式纯文本渲染：增量 append 到 textContent，绕开 Vue vnode diff 与
 * Markdown 全量重解析。仅用于流式中间态；流结束后由外层切回 MarkdownText。
 */
const props = defineProps<{ content: string }>();

const host = ref<HTMLElement | null>(null);
let lastLen = 0;

function paintFull(text: string): void {
  if (!host.value) return;
  host.value.textContent = text;
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
    if (delta) host.value.appendChild(document.createTextNode(delta));
    lastLen = value.length;
  },
  { flush: "sync" },
);
</script>

<template>
  <div ref="host" class="msg__stream msg__text m-0 text-foreground text-[13.5px] leading-[1.75]"></div>
</template>
