<script setup lang="ts">
import { computed } from "vue";
import type { TrendPoint } from "../types";
import { formatDate, formatNumber } from "../utils/format";

const props = defineProps<{ points: TrendPoint[] }>();

const max = computed(() => {
  const values = props.points.flatMap((point) => [point.users, point.audits, point.llmRequests]);
  return Math.max(1, ...values);
});

function height(value: number): string {
  return Math.max(value > 0 ? 4 : 0, (value / max.value) * 100) + "%";
}

const total = computed(() => ({
  users: props.points.reduce((sum, point) => sum + point.users, 0),
  audits: props.points.reduce((sum, point) => sum + point.audits, 0),
  llm: props.points.reduce((sum, point) => sum + point.llmRequests, 0),
}));
</script>

<template>
  <div class="trend">
    <div class="legend">
      <span class="legend-item"><i class="dot users" />新增用户 {{ formatNumber(total.users) }}</span>
      <span class="legend-item"><i class="dot audits" />审计动作 {{ formatNumber(total.audits) }}</span>
      <span class="legend-item"><i class="dot llm" />模型请求 {{ formatNumber(total.llm) }}</span>
    </div>
    <div class="chart">
      <div class="grid-lines" aria-hidden="true">
        <i v-for="line in 4" :key="line" />
      </div>
      <div class="cols">
        <div v-for="point in points" :key="point.date" class="col">
          <div class="bars">
            <i class="bar users" :style="{ height: height(point.users) }" :title="point.date + ' 新增用户 ' + point.users" />
            <i class="bar audits" :style="{ height: height(point.audits) }" :title="point.date + ' 审计动作 ' + point.audits" />
            <i class="bar llm" :style="{ height: height(point.llmRequests) }" :title="point.date + ' 模型请求 ' + point.llmRequests" />
          </div>
          <span class="col-label">{{ formatDate(point.date) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trend {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.legend {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  color: var(--gw-dim);
  font-size: 11.5px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  display: inline-block;
}

.dot.users,
.bar.users {
  background: var(--gw-accent);
}
.dot.audits,
.bar.audits {
  background: var(--gw-violet);
}
.dot.llm,
.bar.llm {
  background: var(--gw-mint);
}

.chart {
  position: relative;
  height: 172px;
  padding: 4px 2px 0;
}

.grid-lines {
  position: absolute;
  inset: 0 0 22px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  pointer-events: none;
}

.grid-lines i {
  height: 1px;
  background: var(--gw-line-soft);
  opacity: 0.7;
}

.cols {
  position: relative;
  height: 100%;
  display: flex;
  align-items: stretch;
  gap: 8px;
}

.col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 8px;
}

.bars {
  flex: 1;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 3px;
  min-height: 0;
}

.bar {
  width: 22%;
  max-width: 10px;
  border-radius: 2px 2px 0 0;
  transition: height 0.35s ease;
  opacity: 0.9;
}

.bar:hover {
  opacity: 1;
}

.col-label {
  text-align: center;
  color: var(--gw-dim);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
</style>
