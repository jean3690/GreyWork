<script setup lang="ts">
import type { InlineToken } from "@/lib/markdown";

/**
 * 行内标记渲染：把 InlineToken[] 摊成 code / strong / em / del / a。
 * 抽成独立组件是为了在段落、标题、列表项、表格单元、引用五处复用同一套分派，
 * 且全程走文本插值 —— 不使用 v-html，模型输出无法注入标记。
 */
defineProps<{ tokens: InlineToken[] }>();
</script>

<template>
  <template v-for="(token, i) in tokens" :key="i">
    <code v-if="token.t === 'code'" class="mdi-code">{{ token.v }}</code>
    <strong v-else-if="token.t === 'bold'">{{ token.v }}</strong>
    <em v-else-if="token.t === 'italic'">{{ token.v }}</em>
    <del v-else-if="token.t === 'strike'">{{ token.v }}</del>
    <a v-else-if="token.t === 'link'" class="mdi-link" :href="token.href" target="_blank" rel="noopener noreferrer">{{ token.v }}</a>
    <template v-else>{{ token.v }}</template>
  </template>
</template>

<style scoped>
.mdi-code {
  font-family: var(--font-mono);
  font-size: 0.88em;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  word-break: break-word;
}
.mdi-link {
  color: var(--cyan);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.mdi-link:hover {
  text-decoration-thickness: 2px;
}
del {
  color: var(--dim2);
}
</style>
