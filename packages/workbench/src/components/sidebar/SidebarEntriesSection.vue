<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { BarChart3, Bot, MessagesSquare, Puzzle } from "lucide-vue-next";

const route = useRoute();
const router = useRouter();

/** 主舞台导航（Cowork 为家；文件查看/编辑在右栏「编辑」标签；设置固定在侧栏左下角；自动化见侧栏快捷入口）。 */
const entries = [
  { id: "chat", label: "Chat·Cowork", icon: MessagesSquare, path: "chat", query: {} },
  { id: "agents", label: "Agents", icon: Bot, path: "agents", query: {} },
  { id: "analytics", label: "数据洞察", icon: BarChart3, path: "analytics", query: {} },
  { id: "market", label: "插件市场", icon: Puzzle, path: "market", query: {} },
] as const;

const activeMode = computed(() => String(route.params.mode ?? "chat"));

async function go(entry: (typeof entries)[number]): Promise<void> {
  await router.push({
    path: `/p/${String(route.params.projectId ?? "p-gw-main")}/${entry.path}`,
    query: entry.query,
  });
}
</script>

<template>
  <nav class="sb-list" aria-label="主舞台导航">
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
