<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import "./theme/shadcn.css";
import "./theme/tokens.css";
import "./theme/base.css";
import { capabilitySeam } from "./plugins/loader";
import { coreBuiltinManifest } from "./plugins/registry";
import { useSettingsStore } from "./stores/settings";
import { useProjectStore } from "./stores/project";
import { useChatStore } from "./stores/chat";
import { bindWorkbenchRouter, ensureMode } from "./router/util";
import ShellSidebar from "./components/ShellSidebar.vue";
import TopBar from "./components/TopBar.vue";
import ActivityPanel from "./components/ActivityPanel.vue";
import StatusBar from "./components/StatusBar.vue";
import MobileTabBar from "./components/MobileTabBar.vue";
import { getGreyWorkCore } from "./components/greyWorkCoreSingleton";

/* ===== Bootstrap：注册默认清单 + 拓扑激活 + token 快照 ===== */
capabilitySeam.register(coreBuiltinManifest);
void capabilitySeam.activateAll();

const settings = useSettingsStore();
watch(
  () => settings.theme,
  (theme) => {
    if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
  },
  { immediate: true },
);
settings.syncEnabledPlugins(capabilitySeam.activeIds());

const projectStore = useProjectStore();
const route = useRoute();
bindWorkbenchRouter(useRouter());

// 路由 projectId → projectStore 同步
watch(
  () => route.params.projectId,
  (projectId) => {
    if (typeof projectId === "string" && projectId) projectStore.setActiveProject(projectId);
  },
  { immediate: true },
);

/* 键盘加速：Ctrl/Cmd+K 新建 thread */
async function onKeydown(event: KeyboardEvent): Promise<void> {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    const project = projectStore.projects.find((candidate) => candidate.id === projectStore.activeProjectId);
    const chat = useChatStore();
    chat.activeThreadId = projectStore.startNewThread(project?.name ?? null);
    await ensureMode("chat");
  }
}

const mobileQuery = typeof window !== "undefined" ? window.matchMedia("(max-width: 640px)") : null;

function onViewportChange(event: MediaQueryListEvent): void {
  if (event.matches) {
    // 移动端由底部 Tab 导航承载入口，避免右栏把主舞台挤出视口。
    sidebarOpen.value = false;
    sideOpen.value = false;
  } else {
    // 回到桌面尺寸时恢复完整工作台；用户仍可手动收起任一栏。
    sidebarOpen.value = true;
    sideOpen.value = true;
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  mobileQuery?.addEventListener("change", onViewportChange);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  mobileQuery?.removeEventListener("change", onViewportChange);
  getGreyWorkCore().dispose();
});

/* 右栏开合 + 侧栏开合（<1180 默认收起） */
const sideOpen = ref(!mobileQuery?.matches);
const narrow = ref(typeof window !== "undefined" && window.matchMedia("(max-width: 1180px)").matches);
const sidebarOpen = ref(!narrow.value);

function toggleSide(): void {
  sideOpen.value = !sideOpen.value;
}
function toggleSidebar(): void {
  sidebarOpen.value = !sidebarOpen.value;
}
</script>

<template>
  <div class="app-shell" data-testid="app-shell">
    <ShellSidebar :collapsed="!sidebarOpen" />
    <div class="shell">
      <TopBar :side-open="sideOpen" :sidebar-open="sidebarOpen" @toggle-side="toggleSide" @toggle-sidebar="toggleSidebar" />
      <div class="body">
        <router-view v-slot="{ Component }">
          <Transition name="view" mode="out-in">
            <component :is="Component" />
          </Transition>
        </router-view>
        <ActivityPanel :open="sideOpen" />
      </div>
      <StatusBar />
      <MobileTabBar />
    </div>
  </div>
</template>
