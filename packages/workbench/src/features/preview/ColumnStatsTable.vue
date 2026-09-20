<script setup lang="ts">
/**
 * 列统计摘要。
 *
 * **一列一块**而不是一张宽表：预览栏最窄只有 320px，把 12 项指标铺成列会横向滚到没法读。
 * 文本 / 日期列只给计数类指标，数值列才追加六项数值摘要 —— 给文本列显示「求和 0」
 * 比不显示更糟。
 */
import { useI18n } from "vue-i18n";
import { formatMetric, type ColumnStats } from "@/lib/data-analysis";

defineProps<{ stats: ColumnStats[] }>();

const { t } = useI18n();

/** 计数类指标：所有列都有。 */
function countMetrics(entry: ColumnStats): { label: string; value: string }[] {
  return [
    { label: t("preview.analysis.stats.count"), value: formatMetric(entry.count) },
    { label: t("preview.analysis.stats.empty"), value: formatMetric(entry.empty) },
    { label: t("preview.analysis.stats.distinct"), value: formatMetric(entry.distinct) },
  ];
}

/** 数值摘要：仅数值列。 */
function numericMetrics(entry: ColumnStats): { label: string; value: string }[] {
  return [
    { label: t("preview.analysis.stats.min"), value: formatMetric(entry.min) },
    { label: t("preview.analysis.stats.max"), value: formatMetric(entry.max) },
    { label: t("preview.analysis.stats.sum"), value: formatMetric(entry.sum) },
    { label: t("preview.analysis.stats.mean"), value: formatMetric(entry.mean) },
    { label: t("preview.analysis.stats.median"), value: formatMetric(entry.median) },
    { label: t("preview.analysis.stats.stdDev"), value: formatMetric(entry.stdDev) },
  ];
}
</script>

<template>
  <div data-testid="column-stats" class="flex flex-col gap-2 p-3">
    <p v-if="stats.length === 0" class="text-[12px] text-dim2">{{ t("preview.analysis.stats.noColumns") }}</p>

    <div v-for="entry in stats" :key="entry.index" class="rounded-[8px] border border-line-2 bg-panel-2 p-2.5">
      <div class="flex items-baseline gap-2">
        <span class="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{{ entry.name }}</span>
        <span class="shrink-0 rounded-[4px] border border-line px-1.5 text-[10.5px] text-dim2">
          {{ t(`preview.analysis.type.${entry.type}`) }}
        </span>
      </div>

      <dl class="mt-2 grid grid-cols-3 gap-x-2 gap-y-1">
        <div v-for="metric in countMetrics(entry)" :key="metric.label" class="min-w-0">
          <dt class="truncate text-[10.5px] text-dim2">{{ metric.label }}</dt>
          <dd class="truncate text-[12px] text-dim">{{ metric.value }}</dd>
        </div>
      </dl>

      <dl v-if="entry.type === 'number'" class="mt-1.5 grid grid-cols-3 gap-x-2 gap-y-1 border-t border-line pt-1.5">
        <div v-for="metric in numericMetrics(entry)" :key="metric.label" class="min-w-0">
          <dt class="truncate text-[10.5px] text-dim2">{{ metric.label }}</dt>
          <dd class="truncate text-[12px] text-dim">{{ metric.value }}</dd>
        </div>
      </dl>
    </div>
  </div>
</template>
