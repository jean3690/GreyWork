<script setup lang="ts">
/**
 * 分组聚合：选分组列 + 数值列 + 聚合方式，出结果表。
 *
 * 聚合口径与图表共用 `lib/data-analysis.groupBy` —— 两处各算一遍迟早会算出不同的数。
 * `count` / `distinct` 不需要数值列，此时把数值列选择器藏起来，免得用户以为选了它才有用。
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { formatMetric, groupBy, type Aggregation } from "@/lib/data-analysis";
import type { DataColumn } from "@/lib/tabular";

const props = defineProps<{ columns: DataColumn[]; rows: string[][] }>();

const { t } = useI18n();

const AGGREGATIONS: Aggregation[] = ["sum", "count", "avg", "min", "max", "distinct"];

const keyColumn = ref(0);
const valueColumn = ref(0);
const aggregation = ref<Aggregation>("sum");

/** 与当前列集对齐：换工作表 / 换文件后旧下标可能越界，直接算会得到 undefined 列。 */
watch(
  () => props.columns,
  (columns) => {
    const numeric = columns.filter((column) => column.type === "number");
    if (!columns.some((column) => column.index === keyColumn.value)) keyColumn.value = columns[0]?.index ?? 0;
    // 值列必须落在**数值列**上：默认下标 0 往往是文本列，拿它求和只会得到一列「—」。
    if (!numeric.some((column) => column.index === valueColumn.value)) valueColumn.value = numeric[0]?.index ?? 0;
    if (aggregation.value === "sum" && numeric.length === 0) aggregation.value = "count";
  },
  { immediate: true },
);

const needsValue = computed(() => aggregation.value !== "count" && aggregation.value !== "distinct");

const result = computed(() =>
  groupBy(props.rows, { keyColumn: keyColumn.value, valueColumn: valueColumn.value, aggregation: aggregation.value }),
);

function label(key: string): string {
  return key === "" ? t("preview.analysis.emptyValue") : key;
}
</script>

<template>
  <div data-testid="group-panel" class="flex flex-col gap-2 p-3">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <label class="flex items-center gap-1 text-[11px] text-dim2">
        {{ t("preview.analysis.group.key") }}
        <select
          v-model.number="keyColumn"
          data-testid="group-key-column"
          class="h-5 cursor-pointer rounded-[5px] border border-line-2 bg-panel px-1 text-[11px] text-foreground"
        >
          <option v-for="column in columns" :key="column.index" :value="column.index">{{ column.name }}</option>
        </select>
      </label>

      <label v-if="needsValue" class="flex items-center gap-1 text-[11px] text-dim2">
        {{ t("preview.analysis.group.value") }}
        <select
          v-model.number="valueColumn"
          data-testid="group-value-column"
          class="h-5 cursor-pointer rounded-[5px] border border-line-2 bg-panel px-1 text-[11px] text-foreground"
        >
          <option v-for="column in columns" :key="column.index" :value="column.index">{{ column.name }}</option>
        </select>
      </label>

      <label class="flex items-center gap-1 text-[11px] text-dim2">
        {{ t("preview.analysis.group.aggregation") }}
        <select
          v-model="aggregation"
          data-testid="group-aggregation"
          class="h-5 cursor-pointer rounded-[5px] border border-line-2 bg-panel px-1 text-[11px] text-foreground"
        >
          <option v-for="option in AGGREGATIONS" :key="option" :value="option">{{ t(`preview.analysis.agg.${option}`) }}</option>
        </select>
      </label>
    </div>

    <p v-if="columns.length === 0" class="text-[12px] text-dim2">{{ t("preview.analysis.group.empty") }}</p>

    <template v-else>
      <table class="w-max border-collapse text-[12px]">
        <thead>
          <tr>
            <th class="sticky top-0 z-10 border border-line bg-panel-2 px-2 py-1 text-left font-medium text-foreground whitespace-nowrap">
              {{ columns.find((column) => column.index === keyColumn)?.name }}
            </th>
            <th class="sticky top-0 z-10 border border-line bg-panel-2 px-2 py-1 text-left font-medium text-foreground whitespace-nowrap">
              {{ t(`preview.analysis.agg.${aggregation}`) }}
            </th>
            <th class="sticky top-0 z-10 border border-line bg-panel-2 px-2 py-1 text-left font-medium text-foreground whitespace-nowrap">
              {{ t("preview.analysis.agg.count") }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(group, index) in result.groups" :key="index">
            <td class="border border-line px-2 py-1 whitespace-nowrap text-dim">{{ label(group.key) }}</td>
            <td class="border border-line px-2 py-1 whitespace-nowrap text-dim">{{ formatMetric(group.value) }}</td>
            <td class="border border-line px-2 py-1 whitespace-nowrap text-dim2">{{ formatMetric(group.count) }}</td>
          </tr>
        </tbody>
      </table>

      <p v-if="result.truncated" class="text-[11px] text-dim2">
        {{ t("preview.analysis.group.truncated", { n: result.groups.length, total: result.total }) }}
      </p>
    </template>
  </div>
</template>
