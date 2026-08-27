<script setup lang="ts" generic="T extends Record<string, unknown>">
import type { HTMLAttributes } from "vue";
import { cn } from "../../../lib/utils";

export interface TableColumn {
  key: string;
  title: string;
  width?: number | string;
  align?: "left" | "right";
}

const props = withDefaults(
  defineProps<{
    columns: TableColumn[];
    data?: T[];
    class?: HTMLAttributes["class"];
  }>(),
  { data: () => [] },
);

function cellValue(row: T, key: string): unknown {
  return row[key as keyof T];
}
</script>

<template>
  <div :class="cn('w-full overflow-x-auto rounded-xl border border-border bg-card', props.class)">
    <table class="w-full border-collapse text-sm">
      <thead>
        <tr class="border-b border-border bg-secondary/60">
          <th
            v-for="col in props.columns"
            :key="col.key"
            class="px-3 py-2 text-xs font-medium text-muted-foreground"
            :style="{ width: col.width, textAlign: col.align ?? 'left' }"
          >
            {{ col.title }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, index) in props.data" :key="index" class="border-b border-border/60 last:border-0">
          <td v-for="col in props.columns" :key="col.key" class="px-3 py-2 text-foreground" :style="{ textAlign: col.align ?? 'left' }">
            <slot :name="'cell-' + col.key" :row="row" :value="cellValue(row, col.key)">
              {{ cellValue(row, col.key) }}
            </slot>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
