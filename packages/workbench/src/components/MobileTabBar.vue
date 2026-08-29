<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { Bot, FolderGit2, MessageSquare, Settings, Store } from "lucide-vue-next";

const { t } = useI18n();

const route = useRoute();
const router = useRouter();

const tabs = computed(() => [
  { id: "chat", label: t("mobile.chat"), icon: MessageSquare },
  { id: "agents", label: "Agent", icon: Bot },
  { id: "market", label: t("mobile.market"), icon: Store },
  { id: "workspaces", label: t("sidebar.workspacesNav"), icon: FolderGit2 },
  { id: "settings", label: t("mobile.settings"), icon: Settings },
]);

const active = computed(() => String(route.params.mode ?? ""));

async function go(id: string): Promise<void> {
  await router.push(`/p/${String(route.params.projectId ?? "p-gw-main")}/${id}`);
}
</script>

<template>
  <nav class="mobile-tabbar" :aria-label="t('mobile.bottomNav')">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      class="mobile-tabbar__btn"
      :class="{ active: active === tab.id }"
      :aria-current="active === tab.id ? 'page' : undefined"
      @click="go(tab.id)"
    >
      <component :is="tab.icon" class="size-4" />
      {{ tab.label }}
    </button>
  </nav>
</template>
