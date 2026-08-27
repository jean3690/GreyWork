<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { capabilitySeam } from "../plugins/loader";
import { useSettingsStore } from "../stores/settings";

const route = useRoute();

const modes = computed(() => capabilitySeam.snapshot().modes);
const currentMode = computed(() => String(route.params.mode ?? ""));

/** 视图组件由注册表快照解析（清单驱动；未知 mode 已被路由守卫回退 chat）。 */
const activeComponent = computed(() => modes.value.find((mode) => mode.id === currentMode.value)?.component ?? modes.value[0]?.component);

async function reactivateBuiltin(): Promise<void> {
  await capabilitySeam.activate("core.builtin");
  useSettingsStore().syncEnabledPlugins(capabilitySeam.activeIds());
}
</script>

<template>
  <main class="stage" :class="{ 'stage--chat': currentMode === 'chat' }" data-testid="workflow-canvas">
    <Transition name="view" mode="out-in" appear>
      <div v-if="modes.length === 0" class="canvas-empty" data-testid="canvas-empty">
        <p class="footnote">当前没有已启用的能力清单。</p>
        <button class="btn btn--primary" data-testid="reactivate-builtin" @click="reactivateBuiltin">启用内置能力</button>
      </div>
      <component :is="activeComponent" v-else />
    </Transition>
  </main>
</template>
