<script setup lang="ts">
/**
 * 分析模式的数据网格：点表头排序 + 有界渲染。
 *
 * 渲染上限沿用表格预览的 500 行 —— 预览栏最窄只有 320px，几万行铺成 DOM 会把主线程钉死。
 * **统计 / 图表 / 分组不受此限**（它们基于全部已筛选行），这里只是「看得少」。
 *
 * 滚动容器与划词作用域都由 `DataAnalysisPanel` 提供，本组件只出表格 —— 否则四个子页签
 * 各带一个滚动容器，滚动位置会在切换页签时互相打架。
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "@/features/shared/Icon.vue";
import Hint from "@/features/shared/Hint.vue";
import type { SortSpec } from "@/lib/data-analysis";
import type { DataColumn } from "@/lib/tabular";

const props = withDefaults(defineProps<{ columns: DataColumn[]; rows: string[][]; sort: SortSpec | null; rowLimit?: number }>(), {
  rowLimit: 500,
});
const emit = defineEmits<{ "update:sort": [value: SortSpec | null] }>();

const { t } = useI18n();

const visibleRows = computed(() => props.rows.slice(0, props.rowLimit));
const truncated = computed(() => props.rows.length > props.rowLimit);

function sortState(index: number): SortSpec["direction"] | null {
  return props.sort?.column === index ? props.sort.direction : null;
}

/** 点表头循环：升序 → 降序 → 不排序。 */
function toggleSort(index: number): void {
  const current = sortState(index);
  if (current === null) {
    emit("update:sort", { column: index, direction: "asc" });
    return;
  }
  emit("update:sort", current === "asc" ? { column: index, direction: "desc" } : null);
}

/** 提示写的是**下一步**会变成什么，而不是当前状态 —— 按钮该说它要做什么。 */
function nextSortTitle(index: number): string {
  const current = sortState(index);
  if (current === "asc") return t("preview.analysis.sort.desc");
  if (current === "desc") return t("preview.analysis.sort.none");
  return t("preview.analysis.sort.asc");
}
</script>

<template>
  <div>
    <table data-testid="analysis-grid" class="w-max border-collapse text-[12px]">
      <thead>
        <tr>
          <th
            v-for="column in columns"
            :key="column.index"
            class="sticky top-0 z-10 border border-line bg-panel-2 p-0 text-left font-medium text-foreground whitespace-nowrap"
          >
            <!-- 可聚焦按钮：换成 Hint 后键盘聚焦也能出提示（原生 title 只认悬停）。 -->
            <Hint :text="nextSortTitle(column.index)">
              <button
                type="button"
                class="flex h-full w-full cursor-pointer items-center gap-1 px-2 py-1 text-left transition-colors hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
                :data-testid="`analysis-sort-${column.index}`"
                :aria-label="`${column.name} · ${nextSortTitle(column.index)}`"
                @click="toggleSort(column.index)"
              >
                <span class="truncate">{{ column.name }}</span>
                <Icon
                  v-if="sortState(column.index)"
                  :name="sortState(column.index) === 'asc' ? 'up' : 'down'"
                  :size="10"
                  class="text-cyan"
                />
              </button>
            </Hint>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, rowIndex) in visibleRows" :key="rowIndex">
          <td v-for="column in columns" :key="column.index" class="border border-line px-2 py-1 whitespace-nowrap text-dim">
            {{ row[column.index] ?? "" }}
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="truncated" class="px-2 py-2 text-[11px] text-dim2">
      {{ t("preview.analysis.gridLimit", { limit: rowLimit, total: rows.length }) }}
    </p>
  </div>
</template>
