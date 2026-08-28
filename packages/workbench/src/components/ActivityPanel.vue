<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { capabilitySeam } from "../plugins/loader";

const { t } = useI18n();

const props = defineProps<{ open: boolean }>();

const tabs = computed(() => capabilitySeam.snapshot().uiRegions.filter((entry) => entry.region === "activityPanel"));

const activeTab = ref<string>(tabs.value[0]?.id ?? "activity.artifacts");

/** 注册表摘除当前激活面板时，回落到首个可用标签。 */
const activeComponent = computed(() => {
  const list = tabs.value;
  const current = list.find((tab) => tab.id === activeTab.value);
  return current?.component ?? list[0]?.component ?? null;
});

/* activeTab 失效（如插件卸载）时回落到首个标签：副作用放 watch，不进 computed。 */
watch([tabs, activeTab], ([list, active]) => {
  if (list.length && !list.some((tab) => tab.id === active)) activeTab.value = list[0]?.id ?? "";
});
</script>

<template>
  <aside v-if="props.open" class="side" data-testid="activity-panel">
    <div class="side__tabs">
      <button v-for="tab in tabs" :key="tab.id" class="side__tab" :class="{ active: activeTab === tab.id }" @click="activeTab = tab.id">
        {{ t(tab.title) }}
      </button>
    </div>
    <component :is="activeComponent" v-if="activeComponent" />
  </aside>
</template>
