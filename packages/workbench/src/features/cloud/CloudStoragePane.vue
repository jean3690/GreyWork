<script setup lang="ts">
import { shallowRef } from "vue";
import { hostApp } from "@greywork/host-ipc";
import { cloudError, cloudRequest, formatCloudBytes, type CloudCollection, type CloudObject } from "@/lib/cloud-api";
import { resolveWorkspaceRoot } from "@/lib/workspace-dir";
import { useCloudStorage } from "./useCloudStorage";
import CloudUploadDialog from "./CloudUploadDialog.vue";
import CloudObjectList from "./CloudObjectList.vue";
import ConfirmDialog from "@/features/settings/ConfirmDialog.vue";
const props = defineProps<{ kind: CloudCollection }>();
const { visible, config, error, query, loading, refresh, remove } = useCloudStorage(props.kind);
const root = shallowRef("");
const uploadOpen = shallowRef(false);
const pendingDelete = shallowRef<CloudObject | null>(null);
async function upload(): Promise<void> {
  try {
    root.value = (await resolveWorkspaceRoot()).dir;
    uploadOpen.value = true;
  } catch (cause) {
    error.value = cloudError(cause);
  }
}
async function download(object: CloudObject): Promise<void> {
  try {
    const ticket = await cloudRequest<{ url: string }>("GET", `/api/storage/objects/${object.id}/download`);
    const url = new URL(ticket.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("无效的下载地址");
    const app = hostApp();
    if (app) await app.openExternal(url.href);
    else {
      const link = document.createElement("a");
      link.href = url.href;
      link.download = object.name;
      link.rel = "noopener";
      link.click();
    }
  } catch (cause) {
    error.value = cloudError(cause);
  }
}
function confirmDelete(): void {
  const object = pendingDelete.value;
  pendingDelete.value = null;
  if (object) void remove(object.id);
}
</script>

<template>
  <div class="mx-auto max-w-[900px]">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-[16px] font-semibold text-foreground">{{ kind === "library" ? "资料库" : "网盘" }}</h2>
        <p class="mt-1 text-[12px] text-dim">
          文件仅当前账号可访问。{{ kind === "library" ? "集中保存参考资料，暂不进行 AI 索引。" : "从工作区上传，随时下载。" }}
        </p>
        <p v-if="config?.enabled" class="mt-1 text-[11px] text-dim2">
          单文件上限 {{ formatCloudBytes(Math.min(config.maxObjectBytes, 128 * 1024 * 1024)) }} · 最多显示最近 200 个文件
        </p>
        <p v-else-if="config" class="mt-1 text-[12px] text-dim">{{ config.reason || "服务器尚未启用对象存储" }}</p>
      </div>
      <div class="flex gap-2">
        <button
          class="rounded-[calc(6px*var(--gw-radius-scale))] border border-line px-3 py-1.5 text-[12px] text-dim disabled:opacity-50"
          :disabled="loading"
          @click="refresh"
        >
          刷新
        </button>
        <button
          class="rounded-[calc(6px*var(--gw-radius-scale))] bg-cyan/15 px-3 py-1.5 text-[12px] text-cyan disabled:opacity-50"
          :disabled="!config?.enabled"
          @click="upload"
        >
          上传文件
        </button>
      </div>
    </div>
    <input
      v-model="query"
      class="mb-3 w-full rounded-[calc(6px*var(--gw-radius-scale))] border border-line bg-panel px-3 py-2 text-[12px] text-foreground"
      placeholder="按文件名筛选"
      aria-label="按文件名筛选"
    />
    <p v-if="error" role="alert" class="mb-3 text-[12px] text-red-400">{{ error }}</p>
    <CloudObjectList :objects="visible" :loading="loading" @download="download" @remove="pendingDelete = $event" />
    <CloudUploadDialog :open="uploadOpen" :root="root" :kind="kind" @update:open="uploadOpen = $event" @uploaded="refresh" />
    <ConfirmDialog
      v-if="pendingDelete"
      title="删除云端文件"
      :message="`确定删除「${pendingDelete.name}」？不会删除本地文件。`"
      confirm-label="删除"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </div>
</template>
