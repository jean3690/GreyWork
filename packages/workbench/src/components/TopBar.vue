<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { PanelLeft, PanelRight, PlugZap } from "lucide-vue-next";
import { RUN_MODES, useSettingsStore, type RunMode } from "../stores/settings";
import { useChatStore } from "../stores/chat";
import { useWorkspaceStore } from "../stores/workspace";
import { useSessionStore } from "../stores/session";
import { capabilitySeam } from "../plugins/loader";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

const chat = useChatStore();
const workspaceStore = useWorkspaceStore();
const sessionStore = useSessionStore();
const settings = useSettingsStore();
const route = useRoute();

const props = defineProps<{ sideOpen: boolean; sidebarOpen: boolean }>();
const emit = defineEmits<{ (event: "toggle-side"): void; (event: "toggle-sidebar"): void }>();

const currentTitle = computed(() => {
  const mode = String(route.params.mode ?? "chat");
  const title = capabilitySeam.snapshot().modes.find((entry) => entry.id === mode)?.title;
  return title ? t(title) : "Cowork";
});

const activeWorkspace = computed(
  () =>
    workspaceStore.workspaces.find((workspace) => workspace.id === workspaceStore.activeWorkspaceId)?.name ?? t("topbar.unnamedWorkspace"),
);

const activeSession = computed(() => sessionStore.getSession(chat.activeThreadId));
const sessionTitle = computed(() => activeSession.value?.title ?? t("topbar.newThread"));
const sessionWorkspace = computed(() => {
  const workspaceId = activeSession.value?.workspaceId;
  return workspaceId ? (workspaceStore.workspaceById(workspaceId)?.name ?? null) : null;
});
</script>

<template>
  <header class="topbar" data-testid="topbar">
    <div class="topbar__crumb">
      <strong>{{ activeWorkspace }}</strong>
      <span class="topbar__slash">/</span>
      <span class="topbar__crumb-mode">{{ currentTitle }}</span>
    </div>

    <div v-if="activeSession" class="topbar__session">
      <strong>{{ sessionTitle }}</strong>
      <span v-if="sessionWorkspace" class="topbar__proj">{{ sessionWorkspace }}</span>
    </div>

    <div class="topbar__mode" role="group" :aria-label="t('settings.runModeLabel')">
      <button
        v-for="runMode in RUN_MODES"
        :key="runMode.value"
        class="topbar__mode-btn"
        :class="{ active: settings.runMode === runMode.value }"
        :title="t(runMode.hint)"
        @click="settings.runMode = runMode.value as RunMode"
      >
        {{ runMode.label }}
      </button>
    </div>

    <div class="topbar__actions">
      <button class="iconbtn iconbtn--wide" :title="t('topbar.ideHint')" disabled><PlugZap class="size-3.5" />IDE</button>
      <button
        class="iconbtn"
        :class="{ active: !props.sidebarOpen }"
        :title="props.sidebarOpen ? t('topbar.collapseSidebar') : t('topbar.expandSidebar')"
        :aria-label="t('topbar.sidebarAria')"
        @click="emit('toggle-sidebar')"
      >
        <PanelLeft class="size-4" />
      </button>
      <button
        class="iconbtn"
        :class="{ active: props.sideOpen }"
        :title="props.sideOpen ? t('topbar.collapseResults') : t('topbar.expandResults')"
        :aria-label="t('topbar.resultsAria')"
        @click="emit('toggle-side')"
      >
        <PanelRight class="size-4" />
      </button>
    </div>
  </header>
</template>
