<script setup lang="ts">
/**
 * Markdown 预览：直接复用对话里那套渲染（`MarkdownText.vue` → `lib/markdown.ts`）。
 * 同一份解析器保证「对话里长什么样，预览里就长什么样」；也顺带继承了它不使用
 * v-html 的性质 —— 内容可能来自模型输出，从根上规避注入。
 */
import { toRef } from "vue";
import MarkdownText from "../MarkdownText.vue";
import { usePreviewText } from "../../lib/preview-content";
import type { PreviewTab } from "../../stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const { data, loading, error } = usePreviewText(toRef(props, "tab"));
</script>

<template>
  <div class="size-full overflow-y-auto px-4 py-3">
    <p v-if="loading" class="text-[12px] text-dim2">读取中…</p>
    <p v-else-if="error" role="alert" class="text-[12px] text-orange">读取失败：{{ error }}</p>
    <!-- 正文宽度与 ConversationView 的 860px 对齐，避免同一份 md 在两处折行位置不同 -->
    <div v-else data-testid="markdown-viewer" data-selection-scope class="mx-auto max-w-[860px]">
      <MarkdownText :content="data ?? ''" />
    </div>
  </div>
</template>
