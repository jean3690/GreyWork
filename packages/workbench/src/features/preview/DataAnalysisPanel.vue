<script setup lang="ts">
/**
 * 数据分析面板：数据 / 统计 / 图表 / 分组四个子页签。
 *
 * **统计口径**：筛选后的行是唯一的输入 —— 统计、图表、分组都基于它，网格再按排序渲染。
 * 这样「筛掉异常值后均值变成多少」是直接可读的，而不必让用户分别去猜哪个视图用了哪份数据。
 *
 * **滚动容器与划词作用域都在这里**，四个子页签不再各带一个 —— 否则切页签时滚动位置会互相打架，
 * 而且划词层会落到没有 `[data-selection-scope]` 的分支上、把整个面板当成作用域。
 *
 * `sheet` 走 `defineModel`：`.xls` 的表格模式与它共用同一个选中工作表（父组件绑定时），
 * 未绑定时退化为本地状态（CSV 没有工作表，xlsx 的 Univer 自己管工作表）。
 */
import { computed, ref, toRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import AnalysisChart from "@/features/preview/AnalysisChart.vue";
import AnalysisGrid from "@/features/preview/AnalysisGrid.vue";
import ColumnStatsTable from "@/features/preview/ColumnStatsTable.vue";
import GroupByPanel from "@/features/preview/GroupByPanel.vue";
import Icon from "@/features/shared/Icon.vue";
import { applyFilters, computeColumnStats, sortRows, type FilterCondition, type FilterOp, type SortSpec } from "@/lib/data-analysis";
import { useDataTable } from "@/lib/data-source";
import type { PreviewTab } from "@/stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const sheet = defineModel<string | null>("sheet", { default: null });

const { t } = useI18n();

const TABS = ["data", "stats", "chart", "group"] as const;
type TabKey = (typeof TABS)[number];

const OPS: FilterOp[] = ["contains", "notContains", "equals", "notEquals", "gt", "gte", "lt", "lte", "empty", "notEmpty"];
/** 这两个算子不需要值：输入框要禁用，否则用户填了也没用，只会以为筛选坏了。 */
const VALUELESS_OPS: ReadonlySet<FilterOp> = new Set<FilterOp>(["empty", "notEmpty"]);

const { data: table, loading, error } = useDataTable(toRef(props, "tab"), () => sheet.value);

const activeTab = ref<TabKey>("data");
const filters = ref<FilterCondition[]>([]);
const sort = ref<SortSpec | null>(null);
const filtersOpen = ref(false);

const columns = computed(() => table.value?.columns ?? []);
const filteredRows = computed(() => (table.value ? applyFilters(table.value.rows, filters.value) : []));
const sortedRows = computed(() => sortRows(filteredRows.value, sort.value, columns.value));
/** 统计只吃筛选后的行；图表与分组同理（传 filteredTable / filteredRows）。 */
const filteredTable = computed(() => (table.value ? { ...table.value, rows: filteredRows.value } : null));
const stats = computed(() => (filteredTable.value ? computeColumnStats(filteredTable.value) : []));

// 换工作表就是换了一份数据：旧筛选按列下标、旧排序按列类型，都不再有意义。
watch(sheet, () => {
  filters.value = [];
  sort.value = null;
});

function addFilter(): void {
  filters.value = [...filters.value, { column: columns.value[0]?.index ?? 0, op: "contains", value: "" }];
}

function removeFilter(index: number): void {
  filters.value = filters.value.filter((_, position) => position !== index);
}

function updateFilter(index: number, patch: Partial<FilterCondition>): void {
  filters.value = filters.value.map((condition, position) => (position === index ? { ...condition, ...patch } : condition));
}

function onFilterColumn(index: number, event: Event): void {
  updateFilter(index, { column: Number((event.target as HTMLSelectElement).value) });
}

function onFilterOp(index: number, event: Event): void {
  updateFilter(index, { op: (event.target as HTMLSelectElement).value as FilterOp });
}

function onFilterValue(index: number, event: Event): void {
  updateFilter(index, { value: (event.target as HTMLInputElement).value });
}

function tabClass(active: boolean): string {
  return [
    "h-6 shrink-0 cursor-pointer rounded-[6px] px-2 text-[11.5px] transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan",
    active ? "bg-panel text-foreground" : "text-dim hover:text-foreground",
  ].join(" ");
}
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-1">
      <div class="flex shrink-0 items-center gap-0.5">
        <button
          v-for="key in TABS"
          :key="key"
          type="button"
          :data-testid="`analysis-tab-${key}`"
          :class="tabClass(activeTab === key)"
          :aria-current="activeTab === key ? 'true' : undefined"
          @click="activeTab = key"
        >
          {{ t(`preview.analysis.tabs.${key}`) }}
        </button>
      </div>

      <div class="ms-auto flex shrink-0 items-center gap-2">
        <label v-if="table && table.sheets.length > 1" class="flex items-center gap-1 text-[11px] text-dim2">
          <span class="sr-only">{{ t("preview.analysis.sheet") }}</span>
          <select
            v-model="sheet"
            data-testid="analysis-sheet-select"
            class="h-5 cursor-pointer rounded-[5px] border border-line-2 bg-panel px-1 text-[11px] text-foreground"
          >
            <option v-for="name in table.sheets" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>

        <button
          v-if="!loading && !error && table"
          type="button"
          data-testid="analysis-filter-toggle"
          :class="tabClass(filtersOpen || filters.length > 0)"
          :aria-expanded="filtersOpen"
          @click="filtersOpen = !filtersOpen"
        >
          {{ t("preview.analysis.filter.toggle") }}<span v-if="filters.length" class="ms-1 text-dim2">{{ filters.length }}</span>
        </button>
      </div>
    </div>

    <!-- 筛选条：对所有子页签生效，所以放在页签下面而不是塞进「数据」页 -->
    <div v-if="filtersOpen && table" class="shrink-0 border-b border-line px-3 py-2" data-testid="analysis-filters">
      <div v-for="(condition, index) in filters" :key="index" class="mb-1.5 flex items-center gap-1">
        <select
          :value="condition.column"
          class="h-5 min-w-0 flex-1 cursor-pointer rounded-[5px] border border-line-2 bg-panel px-1 text-[11px] text-foreground"
          :aria-label="t('preview.analysis.filter.column')"
          @change="onFilterColumn(index, $event)"
        >
          <option v-for="column in columns" :key="column.index" :value="column.index">{{ column.name }}</option>
        </select>
        <select
          :value="condition.op"
          class="h-5 shrink-0 cursor-pointer rounded-[5px] border border-line-2 bg-panel px-1 text-[11px] text-foreground"
          :aria-label="t('preview.analysis.filter.toggle')"
          @change="onFilterOp(index, $event)"
        >
          <option v-for="op in OPS" :key="op" :value="op">{{ t(`preview.analysis.filter.op.${op}`) }}</option>
        </select>
        <input
          type="text"
          class="h-5 min-w-0 flex-1 rounded-[5px] border border-line-2 bg-panel px-1.5 text-[11px] text-foreground"
          :value="condition.value"
          :disabled="VALUELESS_OPS.has(condition.op)"
          :placeholder="t('preview.analysis.filter.value')"
          :aria-label="t('preview.analysis.filter.value')"
          @input="onFilterValue(index, $event)"
        />
        <button
          type="button"
          class="grid size-5 shrink-0 cursor-pointer place-items-center rounded-[5px] text-dim2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :aria-label="t('preview.analysis.filter.clear')"
          @click="removeFilter(index)"
        >
          <Icon name="close" :size="10" />
        </button>
      </div>

      <div class="flex items-center gap-2">
        <button
          type="button"
          data-testid="analysis-filter-add"
          class="cursor-pointer rounded-[6px] border border-line-2 bg-panel px-2 py-0.5 text-[11px] text-dim transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          @click="addFilter()"
        >
          {{ t("preview.analysis.filter.add") }}
        </button>
        <button
          v-if="filters.length"
          type="button"
          class="cursor-pointer rounded-[6px] px-2 py-0.5 text-[11px] text-dim2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          @click="filters = []"
        >
          {{ t("preview.analysis.filter.clear") }}
        </button>
      </div>
    </div>

    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">{{ t("preview.common.loading") }}</p>
    <p v-else-if="error" role="alert" class="px-4 py-3 text-[12px] text-orange">
      {{ t("preview.common.readFailed", { detail: error }) }}
    </p>
    <p v-else-if="!table || table.columns.length === 0" class="px-4 py-3 text-[12px] text-dim2">
      {{ t("preview.analysis.noData") }}
    </p>

    <template v-else>
      <div class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1 text-[11px] text-dim2">
        <span data-testid="analysis-row-summary">{{
          t("preview.analysis.rows", { shown: filteredRows.length, total: table.rows.length })
        }}</span>
        <span v-if="table.truncated" class="text-amber">{{ t("preview.analysis.sourceTruncated", { rows: table.rows.length }) }}</span>
      </div>

      <div class="min-h-0 flex-1 overflow-auto" data-scroll-root data-selection-scope>
        <AnalysisGrid v-if="activeTab === 'data'" :columns="table.columns" :rows="sortedRows" :sort="sort" @update:sort="sort = $event" />
        <ColumnStatsTable v-else-if="activeTab === 'stats'" :stats="stats" />
        <AnalysisChart v-else-if="activeTab === 'chart'" :table="filteredTable ?? table" />
        <GroupByPanel v-else :columns="table.columns" :rows="filteredRows" />
      </div>
    </template>
  </div>
</template>
