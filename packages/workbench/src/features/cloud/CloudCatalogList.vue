<script setup lang="ts">
import type { MarketSkillEntry } from "@greywork/plugins";
import type { McpRegistryEntry } from "@/lib/mcp-registry";
defineProps<{ kind: "skills" | "mcp"; skills: MarketSkillEntry[]; mcps: McpRegistryEntry[]; loading: boolean; busy: boolean }>();
defineEmits<{
  install: [entry: MarketSkillEntry];
  downloadSkill: [entry: MarketSkillEntry];
  register: [entry: McpRegistryEntry];
  downloadMcp: [entry: McpRegistryEntry];
}>();
</script>

<template>
  <div class="overflow-hidden rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel">
    <p v-if="loading" class="p-5 text-[12px] text-dim">正在读取服务器目录…</p>
    <p v-else-if="kind === 'skills' ? !skills.length : !mcps.length" class="p-5 text-[12px] text-dim">
      没有匹配项。可修改搜索词，或请管理员在能力目录中上架资源。
    </p>
    <ul v-else-if="kind === 'skills'" class="divide-y divide-line">
      <li v-for="entry in skills" :key="entry.ref" class="flex items-center gap-3 p-4">
        <div class="min-w-0 flex-1">
          <p class="truncate text-[13px] text-foreground">{{ entry.name }}</p>
          <p class="mt-1 truncate font-mono text-[11px] text-dim2">{{ entry.ref }}</p>
        </div>
        <button
          class="text-[12px] text-dim disabled:opacity-40"
          :disabled="busy || !entry.downloadable"
          @click="$emit('downloadSkill', entry)"
        >
          下载 ZIP
        </button>
        <button class="text-[12px] text-cyan disabled:opacity-40" :disabled="busy || !entry.downloadable" @click="$emit('install', entry)">
          安装到工作区
        </button>
      </li>
    </ul>
    <ul v-else class="divide-y divide-line">
      <li v-for="entry in mcps" :key="entry.name" class="flex items-center gap-3 p-4">
        <div class="min-w-0 flex-1">
          <p class="truncate text-[13px] text-foreground">{{ entry.title || entry.name }}</p>
          <p class="mt-1 text-[11px] text-dim2">{{ entry.description }}</p>
        </div>
        <button class="shrink-0 text-[12px] text-dim" @click="$emit('downloadMcp', entry)">下载配置</button>
        <button class="shrink-0 text-[12px] text-cyan" @click="$emit('register', entry)">添加 MCP</button>
      </li>
    </ul>
  </div>
</template>
