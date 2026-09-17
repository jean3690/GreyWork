<script setup lang="ts">
/**
 * CSV 预览：表格渲染。
 *
 * 只渲染前 `ROW_LIMIT` 行 —— 管线导出的 CSV 动辄几万行，一次性铺成 DOM 会把
 * 主线程钉死几秒；预览的目的是「看一眼对不对」，不是当数据网格用。要全量就下载原文件。
 */
import { computed, toRef } from "vue";
import { parseCsv, splitHeader } from "@/lib/csv";
import { usePreviewText } from "@/lib/preview-content";
import type { PreviewTab } from "@/stores/preview";

const ROW_LIMIT = 500;

const props = defineProps<{ tab: PreviewTab }>();

const { data, loading, error } = usePreviewText(toRef(props, "tab"));

const table = computed(() => splitHeader(parseCsv(data.value ?? "")));
const visibleRows = computed(() => table.value.body.slice(0, ROW_LIMIT));
const truncated = computed(() => table.value.body.length > ROW_LIMIT);
</script>

<template>
  <div data-scroll-root class="size-full overflow-auto">
    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">读取中…</p>
    <p v-else-if="error" role="alert" class="px-4 py-3 text-[12px] text-orange">读取失败：{{ error }}</p>
    <p v-else-if="table.header.length === 0" class="px-4 py-3 text-[12px] text-dim2">空文件</p>
    <template v-else>
      <table data-testid="table-viewer" data-selection-scope class="w-max border-collapse text-[12px]">
        <thead>
          <tr>
            <th
              v-for="(cell, index) in table.header"
              :key="index"
              class="sticky top-0 z-10 border border-line bg-panel-2 px-2 py-1 text-left font-medium text-foreground whitespace-nowrap"
            >
              {{ cell }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, rowIndex) in visibleRows" :key="rowIndex">
            <td v-for="(cell, cellIndex) in row" :key="cellIndex" class="border border-line px-2 py-1 whitespace-nowrap text-dim">
              {{ cell }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="truncated" class="px-2 py-2 text-[11px] text-dim2">仅显示前 {{ ROW_LIMIT }} 行，共 {{ table.body.length }} 行</p>
    </template>
  </div>
</template>
