<script setup lang="ts">
import { useAgentStore } from "../stores/agent";
import Icon from "../components/Icon.vue";

/**
 * 助手库：agent store 的编队成员卡片（只读展示）。
 *
 * 诚实形态：真实 agent 注册表尚未接入，store 初始为空 —— 这里显示空态引导，
 * 而不是渲染冻结的假进度（早期版本 MOCK_AGENTS 让用户看到「正在跑 64%」实则无事发生）。
 * 等成员真正存在后再补选中/跳转交互；在那之前不给卡片假 cursor-pointer。
 */
const agentStore = useAgentStore();
</script>

<template>
  <section class="mx-auto min-h-0 w-full max-w-[860px] overflow-y-auto px-4 py-6 sm:px-6">
    <div class="mb-5">
      <h1 class="font-display text-[20px] font-bold tracking-tight text-foreground">助手库</h1>
      <p class="mt-1 text-[12px] text-dim2">可以调用的 Agent 编队与角色。</p>
    </div>

    <div v-if="agentStore.agents.length === 0" class="flex flex-col items-center gap-3 py-16 text-center" data-testid="assistants-empty">
      <span class="grid size-11 place-items-center rounded-[13px] bg-panel-2 text-dim">
        <Icon name="robot" :size="20" />
      </span>
      <div>
        <p class="text-[13px] font-medium text-foreground">还没有可调用的 Agent</p>
        <p class="mx-auto mt-1 max-w-[360px] text-[12px] leading-relaxed text-dim2">
          对话页的发送条上方可以选择后端（Local / Codex / OpenCode…），运行中的任务会以消息流和产物卡片呈现。 这里将展示可复用的 Agent
          编队，接入后会自动出现。
        </p>
      </div>
    </div>

    <div v-else class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      <article
        v-for="agent in agentStore.agents"
        :key="agent.id"
        class="flex flex-col gap-2.5 rounded-[14px] border border-line bg-panel p-3.5"
      >
        <div class="flex items-center gap-2.5">
          <span class="grid size-8 shrink-0 place-items-center rounded-[9px] bg-panel-2 text-dim">
            <Icon name="robot" :size="16" />
          </span>
          <div class="min-w-0">
            <div class="truncate text-[13px] font-medium text-foreground">{{ agent.name }}</div>
            <div class="truncate text-[11px] text-dim2">{{ agent.role }}</div>
          </div>
        </div>
        <p v-if="agent.tags?.length" class="flex flex-wrap gap-1">
          <span v-for="tag in agent.tags" :key="tag" class="rounded-full bg-panel-2 px-2 py-0.5 text-[10px] text-dim">{{ tag }}</span>
        </p>
      </article>
    </div>
  </section>
</template>
