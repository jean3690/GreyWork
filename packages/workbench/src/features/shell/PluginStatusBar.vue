<script setup lang="ts">
/**
 * 插件状态栏：窗口底部一条细栏，按 manifest 的 `statusBar` 声明渲染。
 *
 * 文案优先级：worker 最近一次 `greywork.setStatus` 的文本 > manifest 的初始 label。
 * 外壳读的是 seam 快照（只有**已激活**插件），所以停用 / 卸载即消失，无需额外清理钩子。
 */
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useCapabilityLoader } from "@/plugins/current";
import { pluginStatusText } from "@/plugins/status";
import type { StatusBarContribution } from "@/plugins/types";

const loader = useCapabilityLoader();
const router = useRouter();

const items = computed<StatusBarContribution[]>(() => loader.snapshot().statusBar);

function open(item: StatusBarContribution): void {
  // 目标是插件自己的页面；没有 mode 的条目在适配层就被过滤掉了。
  void router.push(`/plugin/${item.modeId}`);
}
</script>

<template>
  <div
    v-if="items.length"
    class="flex h-6 shrink-0 items-center gap-3 overflow-x-auto border-t border-line bg-panel px-3 text-[10.5px] text-dim2"
    data-testid="plugin-status-bar"
  >
    <button
      v-for="item in items"
      :key="`${item.pluginId}:${item.id}`"
      type="button"
      class="flex cursor-pointer items-center gap-1.5 rounded-[calc(4px*var(--gw-radius-scale))] px-1 py-0.5 transition-colors hover:bg-panel-2 hover:text-foreground"
      :title="item.pluginId"
      :data-testid="`plugin-status-${item.pluginId}-${item.id}`"
      @click="open(item)"
    >
      <span class="size-1.5 shrink-0 rounded-full bg-cyan/70" aria-hidden="true" />
      <span class="max-w-[280px] truncate">{{ pluginStatusText(item.pluginId, item.id) ?? item.label }}</span>
    </button>
  </div>
</template>
