<script setup lang="ts">
/**
 * 统一 diff 的行级渲染（双列行号 + 增删着色）。
 *
 * 抽出来给「变更」页与「历史」页共用：两处都是同一份 unified diff 文本、同一套着色规则，
 * 各写一遍迟早会在行数上限 / 标记符上走岔。解析交给 `lib/unified-diff`（与 DiffViewer 同一解析器）。
 *
 * 只负责「有内容时怎么画」；空/加载/错误态由调用方决定（它们要放在各自的外层容器里）。
 */
import { computed } from "vue";
import { parseUnifiedDiff } from "@/lib/unified-diff";
import { i18n } from "@/i18n";

const props = defineProps<{ diff: string }>();

const t = i18n.global.t;

/** 单文件最多渲染多少行：超大 diff 全量进 DOM 会把面板拖垮（虚拟化在这里收益不划算）。 */
const LINE_LIMIT = 5000;

const LINE_CLASS: Record<string, string> = {
  header: "bg-panel text-dim2",
  hunk: "bg-panel text-dim2",
  meta: "text-dim2",
  add: "bg-mint/10 text-mint",
  del: "bg-orange/10 text-orange",
  context: "text-dim",
};
const MARKER: Record<string, string> = { add: "+", del: "-", context: " ", meta: "", header: "", hunk: "" };

const files = computed(() => parseUnifiedDiff(props.diff));
</script>

<template>
  <section v-for="file in files" :key="file.path" class="py-1">
    <header class="flex items-center gap-2 border-y border-line px-3 py-1 text-[10.5px]">
      <span class="min-w-0 flex-1 truncate text-dim">{{ file.path }}</span>
      <span class="shrink-0 text-mint">+{{ file.added }}</span>
      <span class="shrink-0 text-orange">-{{ file.removed }}</span>
    </header>
    <div class="px-2 font-mono text-[11px] leading-[1.5]">
      <div v-for="(line, index) in file.lines.slice(0, LINE_LIMIT)" :key="index" class="flex items-start" :class="LINE_CLASS[line.kind]">
        <span class="w-9 shrink-0 select-none px-1 text-right tabular-nums text-dim2">{{ line.oldNo ?? "" }}</span>
        <span class="w-9 shrink-0 select-none px-1 text-right tabular-nums text-dim2">{{ line.newNo ?? "" }}</span>
        <span class="w-3 shrink-0 select-none text-center">{{ MARKER[line.kind] }}</span>
        <span class="min-w-0 flex-1 whitespace-pre-wrap break-all pe-2">{{ line.text }}</span>
      </div>
    </div>
    <p v-if="file.lines.length > LINE_LIMIT" class="px-3 py-1 text-[10.5px] text-dim2">
      {{ t("preview.git.lineLimit", { limit: LINE_LIMIT }) }}
    </p>
  </section>
</template>
