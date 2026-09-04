<script setup lang="ts">
import { useAgentStore } from "../stores/agent";
import Icon from "../components/Icon.vue";

/** 助手库：agent store 的编队成员卡片。选中状态由 store 持有（路由跳转回对话由后续动作接）。 */
const agentStore = useAgentStore();
</script>

<template>
  <section class="mx-auto min-h-0 w-full max-w-[860px] overflow-y-auto px-4 py-6 sm:px-6">
    <div class="mb-5">
      <h1 class="font-display text-[20px] font-bold tracking-tight text-foreground">助手库</h1>
      <p class="mt-1 text-[12px] text-dim2">可以调用的 Agent 编队与角色。</p>
    </div>

    <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      <article
        v-for="agent in agentStore.agents"
        :key="agent.id"
        class="flex cursor-pointer flex-col gap-2.5 rounded-[14px] border border-line bg-panel p-3.5 transition-colors hover:border-line-2 hover:bg-panel-2"
      >
        <div class="flex items-center gap-2.5">
          <span class="grid size-8 shrink-0 place-items-center rounded-[9px] bg-panel-2 text-dim">
            <Icon name="robot" :size="16" />
          </span>
          <div class="min-w-0">
            <div class="truncate text-[13px] font-medium text-foreground">{{ agent.name }}</div>
            <div class="truncate text-[11px] text-dim2">{{ agent.role }}</div>
          </div>
          <span
            class="ml-auto rounded-full px-2 py-0.5 text-[10px]"
            :class="agent.status === 'idle' ? 'bg-panel-2 text-dim' : 'bg-bubble text-foreground'"
          >
            {{ agent.status }}
          </span>
        </div>
        <div class="h-1 overflow-hidden rounded-full bg-panel-2">
          <div class="h-full rounded-full bg-accent transition-[width]" :style="{ width: `${agent.progress ?? 0}%` }" />
        </div>
      </article>
    </div>
  </section>
</template>
