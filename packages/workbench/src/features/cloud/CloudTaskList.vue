<script setup lang="ts">
import type { CloudTask } from "@/lib/cloud-api";
defineProps<{ tasks: CloudTask[]; saving: boolean }>();
defineEmits<{ edit: [task: CloudTask]; toggle: [task: CloudTask]; remove: [task: CloudTask] }>();
</script>

<template>
  <div class="overflow-hidden rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel">
    <p v-if="!tasks.length" class="p-5 text-[12px] text-dim">暂无云端任务。创建任务后，服务器会在到期时通知执行设备。</p>
    <ul v-else class="divide-y divide-line">
      <li v-for="task in tasks" :key="task.id" class="flex flex-wrap items-center gap-3 p-4">
        <div class="min-w-0 flex-1">
          <p class="truncate text-[13px] text-foreground">{{ task.name }}</p>
          <p class="mt-1 text-[11px] text-dim2">{{ task.schedule }} · {{ task.offlinePolicy === "skip" ? "离线跳过" : "上线补跑" }}</p>
          <p class="mt-1 text-[11px] text-dim2">下次触发：{{ task.nextRunAt?.replace("T", " ") ?? "未排期" }}</p>
        </div>
        <button class="text-[12px] text-cyan disabled:opacity-40" :disabled="saving" @click="$emit('toggle', task)">
          {{ task.enabled ? "停用" : "启用" }}
        </button>
        <button class="text-[12px] text-dim disabled:opacity-40" :disabled="saving" @click="$emit('edit', task)">编辑</button>
        <button class="text-[12px] text-dim hover:text-red-400 disabled:opacity-40" :disabled="saving" @click="$emit('remove', task)">
          删除
        </button>
      </li>
    </ul>
  </div>
</template>
