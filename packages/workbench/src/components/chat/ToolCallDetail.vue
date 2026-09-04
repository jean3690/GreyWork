<script setup lang="ts">
/**
 * ToolCallDetail —— 单次工具调用的细节面板：写入内容（diff）/ 输出 / 入参。
 *
 * 长内容只渲染前 maxLines 行，余下折起成「还有 N 行」按钮，点开再全量渲染：
 * 一次 write 可能上千行，全量塞进消息流会把 DOM 和滚动直接拖死。
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolDetail } from "../../types";

const props = withDefaults(defineProps<{ detail: ToolDetail; maxLines?: number }>(), { maxLines: 12 });
const { t } = useI18n();

const expanded = ref(false);

/** diff 行：oldText 逐行 `-`，newText 逐行 `+`；没有 oldText 即整文件写入，只有 `+`。 */
const diffLines = computed(() => {
  const diff = props.detail.diff;
  if (!diff) return [];
  const rows: { tone: "add" | "del"; text: string }[] = [];
  if (diff.oldText) for (const line of diff.oldText.split("\n")) rows.push({ tone: "del", text: line });
  for (const line of diff.newText.split("\n")) rows.push({ tone: "add", text: line });
  return rows;
});
const textLines = computed(() => (props.detail.text ? props.detail.text.split("\n") : []));
const argLines = computed(() => (props.detail.args ? props.detail.args.split("\n") : []));

/** 折叠时每块各留 maxLines 行；三块共用一个展开开关，不要一块一个按钮。 */
function visible<T>(rows: T[]): T[] {
  return expanded.value ? rows : rows.slice(0, props.maxLines);
}

const hiddenLines = computed(() =>
  expanded.value
    ? 0
    : [diffLines.value, textLines.value, argLines.value].reduce((sum, rows) => sum + Math.max(0, rows.length - props.maxLines), 0),
);
</script>

<template>
  <div class="flex flex-col gap-1.5 rounded-[8px] border border-line bg-panel px-2 py-1.5" data-testid="tool-detail">
    <div v-if="detail.diff" class="flex flex-col">
      <div class="mb-0.5 truncate font-mono text-[10.5px] text-dim2">{{ detail.diff.path }}</div>
      <div
        v-for="(row, index) in visible(diffLines)"
        :key="`d${index}`"
        class="whitespace-pre-wrap font-mono text-[11px] leading-[1.55] [overflow-wrap:anywhere]"
        :class="row.tone === 'add' ? 'text-mint' : 'text-destructive'"
      >
        {{ row.tone === "add" ? "+" : "-" }} {{ row.text }}
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
