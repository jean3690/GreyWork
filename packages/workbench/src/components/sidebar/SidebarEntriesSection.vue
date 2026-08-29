<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { BarChart3, Bot, FolderGit2, MessagesSquare, Puzzle } from "lucide-vue-next";

const { t } = useI18n();

const route = useRoute();
const router = useRouter();

/** 主舞台导航（Cowork 为家；文件查看/编辑在右栏「编辑」标签；设置固定在侧栏左下角；自动化见侧栏快捷入口）。 */
const entries = computed(
  () =>
    [
      { id: "chat", label: "Chat·Cowork", icon: MessagesSquare, path: "chat", query: {} },
      { id: "agents", label: "Agents", icon: Bot, path: "agents", query: {} },
      { id: "analytics", label: t("sidebar.analytics"), icon: BarChart3, path: "analytics", query: {} },
      { id: "market", label: t("sidebar.market"), icon: Puzzle, path: "market", query: {} },
      { id: "workspaces", label: t("sidebar.workspacesNav"), icon: FolderGit2, path: "workspaces", query: {} },
    ] as const,
);

const activeMode = computed(() => String(route.params.mode ?? "chat"));

async function go(entry: (typeof entries.value)[number]): Promise<void> {
  await router.push({
    path: `/p/${String(route.params.projectId ?? "p-gw-main")}/${entry.path}`,
    query: entry.query,
  });
}
</script>

<template>
  <nav class="sb-list" :aria-label="t('sidebar.mainStageNav')">
    <button
      v-for="entry in entries"
      :key="entry.id"
      class="sb-entry"
      :class="{ active: activeMode === entry.path }"
      :aria-current="activeMode === entry.path ? 'page' : undefined"
      @click="go(entry)"
    >
      <span class="sb-entry__icon"><component :is="entry.icon" class="size-3.5" /></span>
      {{ entry.label }}
    </button>
  </nav>
</template>
