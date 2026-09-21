<script setup lang="ts">
/**
 * 纯展示网格：表头 + 数据行 + 截断提示。
 *
 * CSV 的表格视图与老格式 `.xls` 的表格视图共用 —— 两者都只需要「把字符串网格铺出来」，
 * 各写一份只会让「截断提示」这类细节在两边慢慢走偏。
 *
 * 只渲染前 `rowLimit` 行：管线导出的表格动辄几万行，一次性铺成 DOM 会把主线程钉死几秒；
 * 预览的目的是「看一眼对不对」，不是当数据网格用。要全量就用系统应用打开原文件。
 *
 * 三个 DOM 契约不能丢：
 * - `data-testid`（默认 `table-viewer`）—— TableViewer 的既有测试按它取表格；
 * - `data-selection-scope` 落在 `<table>` 上 —— 划词层按它定作用域；
 * - `data-scroll-root` 在滚动容器上 —— PreviewSurface 按它记录 / 恢复滚动位置。
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    header: string[];
    rows: string[][];
    /** 渲染行数上限。 */
    rowLimit?: number;
    testId?: string;
  }>(),
  { rowLimit: 500, testId: "table-viewer" },
);

const { t } = useI18n();

const visibleRows = computed(() => props.rows.slice(0, props.rowLimit));
const truncated = computed(() => props.rows.length > props.rowLimit);
</script>

<template>
  <div data-scroll-root class="size-full overflow-auto">
    <p v-if="header.length === 0" class="px-4 py-3 text-[12px] text-dim2">{{ t("preview.table.empty") }}</p>
    <template v-else>
      <table :data-testid="testId" data-selection-scope class="w-max border-collapse text-[12px]">
        <thead>
          <tr>
            <th
              v-for="(cell, index) in header"
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
      <p v-if="truncated" class="px-2 py-2 text-[11px] text-dim2">
        {{ t("preview.table.truncated", { limit: rowLimit, total: rows.length }) }}
      </p>
    </template>
  </div>
</template>
