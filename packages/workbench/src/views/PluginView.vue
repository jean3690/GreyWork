<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { i18n } from "../i18n";
import { useCapabilityLoader } from "../plugins/current";
import { restoreBuiltinPlugins } from "../plugins/runtime";
import { useNoticeStore } from "../stores/notice";

/**
 * 插件贡献的模式页宿主：/plugin/:modeId。
 *
 * 路由是静态占位，组件本身来自 seam 的 modes 快照 —— 插件激活即出现、
 * 停用即回退，宿主不需要知道任何插件内部结构（自由度的来源）。
 * 回退页除「回会话」外提供「恢复内置插件」：插件中心被自己停用后，
 * 这是 UI 内唯一还能把它叫回来的入口（另见空清单上的同款按钮）。
 */
const t = i18n.global.t;
const route = useRoute();
const router = useRouter();
const notices = useNoticeStore();
const restoring = ref(false);

const modeId = computed(() => {
  const raw = route.params.modeId;
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
});

const mode = computed(() =>
  useCapabilityLoader()
    .snapshot()
    .modes.find((candidate) => candidate.id === modeId.value),
);

async function restore(): Promise<void> {
  restoring.value = true;
  try {
    await restoreBuiltinPlugins();
    notices.success(t("market.restoredBuiltins"), undefined, { key: "plugins-restore" });
  } catch (error) {
    notices.error(t("market.restoreFailed"), error instanceof Error ? error.message : String(error), {
      key: "plugins-restore",
    });
  } finally {
    restoring.value = false;
  }
}
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <component :is="mode?.component" v-if="mode" :key="modeId" />
    <div v-else class="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <p class="text-[13px] text-dim">插件「{{ modeId }}」不存在或已被停用。</p>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel-2 px-3 text-[12px] text-foreground transition-colors hover:border-line-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          @click="router.push('/guid')"
        >
          回会话
        </button>
        <button
          type="button"
          class="h-7 cursor-pointer rounded-[7px] bg-accent px-3 text-[12px] font-medium text-accent-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="restoring"
          @click="restore"
        >
          {{ restoring ? "…" : t("market.restoreBuiltins") }}
        </button>
      </div>
    </div>
  </div>
</template>
