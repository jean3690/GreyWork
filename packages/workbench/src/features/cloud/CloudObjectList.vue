<script setup lang="ts">
import { formatCloudBytes, type CloudObject } from "@/lib/cloud-api";
defineProps<{ objects: CloudObject[]; loading: boolean }>();
defineEmits<{ download: [object: CloudObject]; remove: [object: CloudObject] }>();
</script>

<template>
  <div class="overflow-hidden rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel">
    <p v-if="loading" class="p-5 text-[12px] text-dim">正在加载文件…</p>
    <p v-else-if="!objects.length" class="p-5 text-[12px] text-dim">暂无文件。点击“上传文件”，选择工作区中的文件。</p>
    <ul v-else class="divide-y divide-line">
      <li v-for="object in objects" :key="object.id" class="flex items-center gap-3 px-4 py-3">
        <div class="min-w-0 flex-1">
          <p class="truncate text-[13px] text-foreground">{{ object.name }}</p>
          <p class="mt-1 text-[11px] text-dim2">
            {{ formatCloudBytes(object.sizeBytes) }} · {{ object.createdAt.replace("T", " ") }} ·
            {{ object.status === "ready" ? "已上传" : "待确认" }}
          </p>
        </div>
        <button class="text-[12px] text-cyan disabled:opacity-40" :disabled="object.status !== 'ready'" @click="$emit('download', object)">
          下载
        </button>
        <button class="text-[12px] text-dim hover:text-red-400" @click="$emit('remove', object)">删除</button>
      </li>
    </ul>
  </div>
</template>
