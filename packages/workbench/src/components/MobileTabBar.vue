<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Bot, MessageSquare, Settings, Store } from "lucide-vue-next";

const route = useRoute();
const router = useRouter();

const tabs = [
  { id: "chat", label: "对话", icon: MessageSquare },
  { id: "agents", label: "Agent", icon: Bot },
  { id: "market", label: "市场", icon: Store },
  { id: "settings", label: "设置", icon: Settings },
];

const active = computed(() => String(route.params.mode ?? ""));

async function go(id: string): Promise<void> {
  await router.push(`/p/${String(route.params.projectId ?? "p-gw-main")}/${id}`);
}
</script>

<template>
  <nav class="mobile-tabbar" aria-label="底部导航">
    <button
      v-for="t in tabs"
      :key="t.id"
      class="mobile-tabbar__btn"
      :class="{ active: active === t.id }"
      :aria-current="active === t.id ? 'page' : undefined"
      @click="go(t.id)"
    >
      <component :is="t.icon" class="size-4" />
      {{ t.label }}
    </button>
  </nav>
</template>
