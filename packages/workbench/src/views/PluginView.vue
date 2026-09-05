<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useCapabilityLoader } from "../plugins/current";

/**
 * 插件贡献的模式页宿主：/plugin/:modeId。
 *
 * 路由是静态占位，组件本身来自 seam 的 modes 快照 —— 插件激活即出现、
 * 停用即回退，宿主不需要知道任何插件内部结构（自由度的来源）。
 */
const route = useRoute();
const router = useRouter();

const modeId = computed(() => {
  const raw = route.params.modeId;
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
});

const mode = computed(() =>
  useCapabilityLoader()
    .snapshot()
    .modes.find((candidate) => candidate.id === modeId.value),
);
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <component :is="mode?.component" v-if="mode" :key="modeId" />
    <div v-else class="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <p class="text-[13px] text-dim">插件「{{ modeId }}」不存在或已被停用。</p>
      <button
        type="button"
        class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel-2 px-3 text-[12px] text-foreground transition-colors hover:border-line-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        @click="router.push('/guid')"
      >
        回会话
      </button>
    </div>
  </div>
</template>
