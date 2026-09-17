<script setup lang="ts">
/** 设置 · team 分区：编排并发度滑块。 */
import { MAX_PARALLEL_RANGE, useSettingsStore } from "@/stores/settings";

const settings = useSettingsStore();

function onMaxParallelInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  if (Number.isInteger(raw)) settings.maxParallel = raw;
  settings.persist();
}
</script>

<template>
  <div class="rounded-[14px] border border-line bg-panel p-4">
    <div class="text-[13px] font-medium text-fg">编排并发度</div>
    <p class="mt-1 text-[12px] text-dim2">多智能体协作时同时运行的回合上限；调高可加速但需要更多进程资源。</p>
    <div class="mt-3 flex items-center gap-3">
      <input
        type="range"
        :min="MAX_PARALLEL_RANGE.min"
        :max="MAX_PARALLEL_RANGE.max"
        step="1"
        :value="settings.maxParallel"
        data-testid="max-parallel"
        class="h-1 w-48 cursor-pointer accent-accent"
        @input="onMaxParallelInput"
      />
      <span class="w-6 text-center text-[13px] font-medium text-fg" data-testid="max-parallel-value">{{ settings.maxParallel }}</span>
    </div>
    <p class="mt-2 text-[11px] text-dim2">范围 1–8，默认 2。更改即时生效。</p>
  </div>
</template>
