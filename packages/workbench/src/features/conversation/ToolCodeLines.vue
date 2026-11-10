<script setup lang="ts">
/**
 * 工具细节里的逐行代码块：行号槽 + 可选语法高亮。
 *
 * 命令 / 输出 / 入参三种片段共用；diff 有自己的双列行号与增减标记，不复用。
 * 高亮 HTML 由 `useCodeHighlights` 生成（已转义），没有时退回纯文本插值。
 */
withDefaults(
  defineProps<{
    lines: string[];
    /** 与 lines 一一对应的 HTML；null 表示不着色。 */
    html: string[] | null;
    /** 行号槽形态：number = 1 起行号；prompt = 首行 $（命令块）。 */
    gutter?: "number" | "prompt";
    /** 无高亮时的行文本色。 */
    tone?: string;
  }>(),
  { gutter: "number", tone: "text-dim" },
);
</script>

<template>
  <div class="flex flex-col font-mono text-[11px] leading-[1.55]">
    <div v-for="(line, index) in lines" :key="index" class="flex items-start" data-testid="tool-code-line">
      <template v-if="gutter === 'prompt'">
        <span class="w-3 shrink-0 select-none text-center text-mint/80" aria-hidden="true">{{ index === 0 ? "$" : "" }}</span>
      </template>
      <template v-else>
        <span class="w-8 shrink-0 select-none px-1 text-right tabular-nums text-dim2" aria-hidden="true">{{ index + 1 }}</span>
      </template>
      <span v-if="html?.[index]" class="min-w-0 flex-1 whitespace-pre-wrap pe-1 [overflow-wrap:anywhere]" v-html="html[index]" />
      <span v-else class="min-w-0 flex-1 whitespace-pre-wrap pe-1 [overflow-wrap:anywhere]" :class="tone">{{ line }}</span>
    </div>
  </div>
</template>
