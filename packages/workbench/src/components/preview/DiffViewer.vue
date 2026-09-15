<script setup lang="ts">
/**
 * unified diff（`.diff` / `.patch`）预览：行级着色 + 双列行号。
 * 解析在 `lib/unified-diff.ts`（含「为什么不用 @codemirror/merge」的理由）。
 */
import { computed, toRef } from "vue";
import { parseUnifiedDiff, type DiffLineKind } from "../../lib/unified-diff";
import { usePreviewText } from "../../lib/preview-content";
import type { PreviewTab } from "../../stores/preview";

/** 单文件段的渲染行上限：超大 patch 一次性铺开会卡死渲染。 */
const LINE_LIMIT = 5000;

const props = defineProps<{ tab: PreviewTab }>();

const { data, loading, error } = usePreviewText(toRef(props, "tab"));

const files = computed(() => parseUnifiedDiff(data.value ?? ""));

const LINE_CLASS: Record<DiffLineKind, string> = {
  header: "bg-panel text-dim2",
  hunk: "bg-panel text-dim2",
  meta: "text-dim2",
  add: "bg-mint/10 text-mint",
  del: "bg-orange/10 text-orange",
  context: "text-dim",
};

/** 行首标记：与 patch 原文一致，方便复制出去还能用。 */
const MARKER: Record<DiffLineKind, string> = {
  header: "",
  hunk: "",
  meta: "",
  add: "+",
  del: "-",
  context: " ",
};
</script>

<template>
  <div data-selection-scope data-scroll-root class="size-full overflow-auto font-mono text-[12px]">
    <p v-if="loading" class="px-4 py-3 text-dim2">读取中…</p>
    <p v-else-if="error" role="alert" class="px-4 py-3 text-orange">读取失败：{{ error }}</p>
    <p v-else-if="files.length === 0" class="px-4 py-3 text-dim2">没有可显示的变更</p>
    <template v-else>
      <section v-for="file in files" :key="file.path" data-testid="diff-file" class="mb-2">
        <header class="sticky top-0 z-10 flex items-center gap-2 border-y border-line bg-panel-2 px-3 py-1.5 text-[11.5px]">
          <span class="min-w-0 flex-1 truncate text-foreground">{{ file.path }}</span>
          <span class="shrink-0 text-mint">+{{ file.added }}</span>
          <span class="shrink-0 text-orange">-{{ file.removed }}</span>
        </header>
        <div v-for="(line, index) in file.lines.slice(0, LINE_LIMIT)" :key="index" class="flex items-start" :class="LINE_CLASS[line.kind]">
          <!-- 行号与标记列不计入划词采集：用户选中的是代码，不是行号 -->
          <span data-selection-exclude class="w-10 shrink-0 select-none px-1 text-right tabular-nums text-dim2">{{
            line.oldNo ?? ""
          }}</span>
          <span data-selection-exclude class="w-10 shrink-0 select-none px-1 text-right tabular-nums text-dim2">{{
            line.newNo ?? ""
          }}</span>
          <span data-selection-exclude class="w-3 shrink-0 select-none text-center">{{ MARKER[line.kind] }}</span>
          <span class="min-w-0 flex-1 whitespace-pre-wrap break-all pe-3">{{ line.text }}</span>
        </div>
        <p v-if="file.lines.length > LINE_LIMIT" class="px-3 py-1.5 text-[11px] text-dim2">
          仅显示前 {{ LINE_LIMIT }} 行，该文件段共 {{ file.lines.length }} 行
        </p>
      </section>
    </template>
  </div>
</template>
