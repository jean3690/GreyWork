<script setup lang="ts">
/**
 * ToolCallDetail —— 单次工具调用的细节面板：改动差分 / 输出 / 入参。
 *
 * 改动块走真正的行级 LCS 差分（`diffTexts`）：只标真正增删的行，并给出 +N/-N，
 * 视觉沿用 DiffViewer 的既有语言（双列行号 + 标记列 + 增删底色）。早先的实现把
 * oldText 每行标 `-`、newText 每行标 `+`，改一行会显示成整文件删除 + 整文件新增。
 *
 * 长内容只渲染前 maxLines 行，余下折起成「还有 N 行」按钮，点开再全量渲染：
 * 一次 write 可能上千行，全量塞进消息流会把 DOM 和滚动直接拖死。
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { diffTexts, type DiffLine } from "@/lib/unified-diff";
import type { ToolDetail } from "@/types";

const props = withDefaults(defineProps<{ detail: ToolDetail; maxLines?: number }>(), { maxLines: 12 });
const { t } = useI18n();

const expanded = ref(false);

/** 改动块：路径 + 行级差分 + 增删统计。无 diff 时为 null。 */
const diff = computed(() => {
  const raw = props.detail.diff;
  if (!raw) return null;
  const result = diffTexts(raw.oldText, raw.newText);
  return { path: raw.path, ...result };
});

const diffLines = computed<DiffLine[]>(() => diff.value?.lines ?? []);
// 按 `\r\n|\n|\r` 拆行：Windows 上工具输出常是 CRLF，只按 `\n` 拆会在每行尾留一个 `\r`
// （渲染上看不见，但复制出去就是脏字符）。
const textLines = computed(() => (props.detail.text ? props.detail.text.split(/\r\n|\n|\r/) : []));
const argLines = computed(() => (props.detail.args ? props.detail.args.split(/\r\n|\n|\r/) : []));

/** 折叠时每块各留 maxLines 行；三块共用一个展开开关，不要一块一个按钮。 */
function visible<T>(rows: T[]): T[] {
  return expanded.value ? rows : rows.slice(0, props.maxLines);
}

const hiddenLines = computed(() =>
  expanded.value
    ? 0
    : [diffLines.value, textLines.value, argLines.value].reduce((sum, rows) => sum + Math.max(0, rows.length - props.maxLines), 0),
);

/** 行首标记：与 patch 原文一致，方便复制出去还能用。 */
const MARKER: Record<string, string> = { add: "+", del: "-", context: " " };

/** 行底色/字色：与 DiffViewer 对齐（新增 mint、删除 orange）。 */
const LINE_CLASS: Record<string, string> = {
  add: "bg-mint/10 text-mint",
  del: "bg-orange/10 text-orange",
  context: "text-dim",
};
</script>

<template>
  <div class="flex flex-col gap-1.5 rounded-[8px] border border-line bg-panel px-2 py-1.5" data-testid="tool-detail">
    <div v-if="diff" class="flex flex-col" data-testid="tool-diff">
      <div class="mb-1 flex items-center gap-2 border-b border-line/70 pb-1">
        <span class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-dim2">{{ diff.path }}</span>
        <span v-if="diff.added" class="shrink-0 font-mono text-[10.5px] tabular-nums text-mint" data-testid="tool-diff-added"
          >+{{ diff.added }}</span
        >
        <span v-if="diff.removed" class="shrink-0 font-mono text-[10.5px] tabular-nums text-orange" data-testid="tool-diff-removed"
          >-{{ diff.removed }}</span
        >
      </div>
      <div
        v-for="(row, index) in visible(diffLines)"
        :key="`d${index}`"
        class="flex items-start font-mono text-[11px] leading-[1.55]"
        :class="LINE_CLASS[row.kind]"
      >
        <span class="w-8 shrink-0 select-none px-1 text-right tabular-nums text-dim2">{{ row.oldNo ?? "" }}</span>
        <span class="w-8 shrink-0 select-none px-1 text-right tabular-nums text-dim2">{{ row.newNo ?? "" }}</span>
        <span class="w-3 shrink-0 select-none text-center">{{ MARKER[row.kind] ?? "" }}</span>
        <span class="min-w-0 flex-1 whitespace-pre-wrap pe-1 [overflow-wrap:anywhere]">{{ row.text }}</span>
      </div>
    </div>

    <div v-if="textLines.length" class="flex flex-col">
      <div class="mb-0.5 text-[10.5px] text-dim2">{{ t("chatView.tools.output") }}</div>
      <div
        v-for="(line, index) in visible(textLines)"
        :key="`t${index}`"
        class="whitespace-pre-wrap font-mono text-[11px] leading-[1.55] text-dim [overflow-wrap:anywhere]"
      >
        {{ line }}
      </div>
    </div>

    <div v-if="argLines.length" class="flex flex-col">
      <div class="mb-0.5 text-[10.5px] text-dim2">{{ t("chatView.tools.args") }}</div>
      <div
        v-for="(line, index) in visible(argLines)"
        :key="`a${index}`"
        class="whitespace-pre-wrap font-mono text-[11px] leading-[1.55] text-dim2 [overflow-wrap:anywhere]"
      >
        {{ line }}
      </div>
    </div>

    <div v-if="detail.terminalId" class="font-mono text-[10.5px] text-dim2">
      {{ t("chatView.tools.terminal", { id: detail.terminalId }) }}
    </div>

    <div class="flex items-center gap-2">
      <button
        v-if="hiddenLines > 0 || expanded"
        type="button"
        class="cursor-pointer rounded-[6px] border border-line px-1.5 py-0.5 text-[10.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground [font-family:inherit]"
        data-testid="tool-detail-toggle"
        @click="expanded = !expanded"
      >
        {{ expanded ? t("chatView.tools.collapseLines") : t("chatView.tools.moreLines", { n: hiddenLines }) }}
      </button>
      <span v-if="detail.clipped" class="text-[10.5px] text-amber">{{ t("chatView.tools.clipped") }}</span>
    </div>
  </div>
</template>
