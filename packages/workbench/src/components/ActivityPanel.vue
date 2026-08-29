<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { capabilitySeam } from "../plugins/loader";

const { t } = useI18n();

const props = defineProps<{ open: boolean }>();

const allTabs = computed(() => capabilitySeam.snapshot().uiRegions.filter((entry) => entry.region === "activityPanel"));
const tabs = computed(() => allTabs.value.filter((tab) => !tab.overflow));
const moreTabs = computed(() => allTabs.value.filter((tab) => tab.overflow));

const activeTab = ref<string>(allTabs.value[0]?.id ?? "activity.artifacts");
const moreOpen = ref(false);

/** 注册表摘除当前激活面板时，回落到首个可用标签。 */
const activeComponent = computed(() => {
  const list = allTabs.value;
  const current = list.find((tab) => tab.id === activeTab.value);
  return current?.component ?? list[0]?.component ?? null;
});

/* activeTab 失效（如插件卸载）时回落到首个标签：副作用放 watch，不进 computed。 */
watch([allTabs, activeTab], ([list, active]) => {
  if (list.length && !list.some((tab) => tab.id === active)) activeTab.value = list[0]?.id ?? "";
});

function pickTab(id: string): void {
  activeTab.value = id;
  moreOpen.value = false;
}

/* 点击面板外关闭「更多」下拉；按钮与菜单自身用 @click.stop 阻断，避免同一次点击立刻关掉。 */
function onDocumentClick(): void {
  moreOpen.value = false;
}
onMounted(() => document.addEventListener("click", onDocumentClick));
onBeforeUnmount(() => document.removeEventListener("click", onDocumentClick));
</script>

<template>
  <aside v-if="props.open" class="side" data-testid="activity-panel">
    <div class="side__tabbar">
      <div class="side__tabs">
        <button v-for="tab in tabs" :key="tab.id" class="side__tab" :class="{ active: activeTab === tab.id }" @click="pickTab(tab.id)">
          {{ t(tab.title) }}
        </button>
      </div>
      <div v-if="moreTabs.length" class="side__more">
        <button
          class="side__tab side__more-btn"
          :class="{ active: moreTabs.some((tab) => tab.id === activeTab) }"
          :aria-expanded="moreOpen"
          aria-haspopup="menu"
          @click.stop="moreOpen = !moreOpen"
        >
          {{ t("panels.more") }}<span class="side__more-caret" aria-hidden="true">▾</span>
        </button>
        <div v-if="moreOpen" class="side__more-pop" role="menu" @click.stop>
          <button
            v-for="tab in moreTabs"
            :key="tab.id"
            class="side__more-opt"
            :class="{ active: activeTab === tab.id }"
            role="menuitem"
            @click="pickTab(tab.id)"
          >
            {{ t(tab.title) }}
          </button>
        </div>
      </div>
    </div>
    <component :is="activeComponent" v-if="activeComponent" />
  </aside>
</template>
