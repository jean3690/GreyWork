<script setup lang="ts">
import { computed, defineAsyncComponent } from "vue";
import { useRoute } from "vue-router";
import CloudAccountGate from "./CloudAccountGate.vue";
import Icon from "@/features/shared/Icon.vue";
const CloudStoragePane = defineAsyncComponent(() => import("./CloudStoragePane.vue"));
const CloudTasksPane = defineAsyncComponent(() => import("./CloudTasksPane.vue"));
const CloudCatalogPane = defineAsyncComponent(() => import("./CloudCatalogPane.vue"));
const route = useRoute();
const tabs = [
  { key: "drive", label: "网盘", icon: "folder" },
  { key: "library", label: "资料库", icon: "file-text" },
  { key: "catalog", label: "MCP / Skills 下载", icon: "lightning" },
  { key: "tasks", label: "云端定时任务", icon: "alarm-clock" },
];
const section = computed(() => (tabs.some((tab) => tab.key === route.params.section) ? String(route.params.section) : "drive"));
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-panel-2" data-testid="cloud-more-view">
    <header class="shrink-0 border-b border-line px-5 pb-3 pt-5">
      <h1 class="font-display text-[20px] font-semibold text-foreground">更多</h1>
      <nav class="mt-4 flex flex-wrap gap-1" aria-label="服务器功能">
        <RouterLink
          v-for="tab in tabs"
          :key="tab.key"
          :to="`/more/${tab.key}`"
          class="flex items-center gap-2 rounded-[calc(7px*var(--gw-radius-scale))] px-3 py-2 text-[12px] focus-visible:outline-2 focus-visible:outline-cyan"
          :class="section === tab.key ? 'bg-panel text-foreground' : 'text-dim hover:bg-panel'"
          :aria-current="section === tab.key ? 'page' : undefined"
        >
          <Icon :name="tab.icon" :size="14" />{{ tab.label }}
        </RouterLink>
      </nav>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
      <CloudAccountGate>
        <CloudStoragePane
          v-if="section === 'drive' || section === 'library'"
          :key="section"
          :kind="section === 'library' ? 'library' : 'file'"
        />
        <CloudCatalogPane v-else-if="section === 'catalog'" />
        <CloudTasksPane v-else />
      </CloudAccountGate>
    </div>
  </section>
</template>
