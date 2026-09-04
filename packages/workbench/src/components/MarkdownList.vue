<script setup lang="ts">
import type { ListNode } from "../lib/markdown";
import MarkdownInline from "./MarkdownInline.vue";

/**
 * 列表渲染：按 ListNode 递归出真实的 ul/ol 嵌套结构。
 * 不用「单层 ul + 缩进 padding」假装层级 —— 屏幕阅读器需要真实嵌套才能播报层级关系。
 */
defineProps<{ node: ListNode }>();
</script>

<template>
  <ol v-if="node.ordered" class="mdl" :start="node.start">
    <li v-for="(item, i) in node.items" :key="i">
      <MarkdownInline :tokens="item.inline" />
      <MarkdownList v-if="item.children" :node="item.children" />
    </li>
  </ol>
  <ul v-else class="mdl">
    <li v-for="(item, i) in node.items" :key="i">
      <MarkdownInline :tokens="item.inline" />
      <MarkdownList v-if="item.children" :node="item.children" />
    </li>
  </ul>
</template>

<style scoped>
.mdl {
  margin: 6px 0;
  padding-left: 1.35em;
}
.mdl li {
  margin: 3px 0;
  line-height: 1.65;
}
/* 嵌套层收紧上下留白，避免层级越深越松散 */
.mdl .mdl {
  margin: 2px 0;
}
ul.mdl {
  list-style: disc;
}
ul.mdl ul.mdl {
  list-style: circle;
}
ul.mdl ul.mdl ul.mdl {
  list-style: square;
}
ol.mdl {
  list-style: decimal;
}
</style>
