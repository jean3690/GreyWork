<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { PanelLeft, PanelRight, PlugZap } from "lucide-vue-next";
import { RUN_MODES, useSettingsStore, type RunMode } from "../stores/settings";
import { useChatStore } from "../stores/chat";
import { useProjectStore } from "../stores/project";
import { capabilitySeam } from "../plugins/loader";

const chat = useChatStore();
const projectStore = useProjectStore();
const settings = useSettingsStore();
const route = useRoute();

const props = defineProps<{ sideOpen: boolean; sidebarOpen: boolean }>();
const emit = defineEmits<{ (event: "toggle-side"): void; (event: "toggle-sidebar"): void }>();

const currentTitle = computed(() => {
  const mode = String(route.params.mode ?? "chat");
  return capabilitySeam.snapshot().modes.find((entry) => entry.id === mode)?.title ?? "Cowork";
});

const activeProject = computed(
  () => projectStore.projects.find((project) => project.id === projectStore.activeProjectId)?.name ?? "未命名项目",
);

const activeThread = computed(() => {
  for (const group of projectStore.threadGroups) {
    const hit = group.threads.find((thread) => thread.id === chat.activeThreadId);
    if (hit) return { thread: hit, project: group.project };
  }
  return null;
});
const sessionTitle = computed(() => activeThread.value?.thread.title ?? "新对话");
const sessionProject = computed(() => activeThread.value?.project ?? null);
</script>

<template>
  <header class="topbar" data-testid="topbar">
    <div class="topbar__crumb">
      <strong>{{ activeProject }}</strong>
      <span class="topbar__slash">/</span>
      <span class="topbar__crumb-mode">{{ currentTitle }}</span>
    </div>

    <div v-if="activeThread" class="topbar__session">
      <strong>{{ sessionTitle }}</strong>
      <span v-if="sessionProject" class="topbar__proj">{{ sessionProject }}</span>
    </div>

    <div class="topbar__mode" role="group" aria-label="运行模式">
      <button
        v-for="runMode in RUN_MODES"
        :key="runMode.value"
        class="topbar__mode-btn"
        :class="{ active: settings.runMode === runMode.value }"
        :title="runMode.hint"
        @click="settings.runMode = runMode.value as RunMode"
      >
        {{ runMode.label }}
      </button>
    </div>

    <div class="topbar__actions">
      <button class="iconbtn iconbtn--wide" title="连接 IDE（桌面端宿主能力，未接入）" disabled><PlugZap class="size-3.5" />IDE</button>
      <button
        class="iconbtn"
        :class="{ active: !props.sidebarOpen }"
        :title="props.sidebarOpen ? '收起侧边栏' : '展开侧边栏'"
        aria-label="侧边栏"
        @click="emit('toggle-sidebar')"
      >
        <PanelLeft class="size-4" />
      </button>
      <button
        class="iconbtn"
        :class="{ active: props.sideOpen }"
        :title="props.sideOpen ? '收起成果展示区' : '展开成果展示区：Diff / 预览 / 终端'"
        aria-label="成果展示区"
        @click="emit('toggle-side')"
      >
        <PanelRight class="size-4" />
      </button>
    </div>
  </header>
</template>
