<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { invoke } from "@greywork/host-ipc";
import { cloudError, cloudUpload, formatCloudBytes, type CloudCollection } from "@/lib/cloud-api";
import { useUserAccountStore } from "@/stores/user-account";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
interface Entry {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number | null;
}
const props = defineProps<{ open: boolean; root: string; kind: CloudCollection }>();
const emit = defineEmits<{ "update:open": [open: boolean]; uploaded: [] }>();
const account = useUserAccountStore();
const entries = shallowRef<Entry[]>([]);
const stack = shallowRef<string[]>([]);
const selected = shallowRef<Map<string, Entry>>(new Map());
const loading = shallowRef(false);
const uploading = shallowRef(false);
const progress = shallowRef("");
const error = shallowRef("");
const directory = computed(() => stack.value.at(-1) ?? props.root);
const sortedEntries = computed(() => [...entries.value].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)));
let revision = 0;
async function load(): Promise<void> {
  const current = ++revision;
  loading.value = true;
  error.value = "";
  try {
    const rows = await invoke<Entry[]>("fs_list_dir", { path: directory.value });
    if (revision === current) entries.value = rows;
  } catch (cause) {
    if (revision === current) error.value = cloudError(cause);
  } finally {
    if (revision === current) loading.value = false;
  }
}
watch(
  () => props.open,
  (open) => {
    if (open) {
      stack.value = [];
      selected.value = new Map();
      progress.value = "";
      void load();
    } else revision += 1;
  },
  { immediate: true },
);
function enter(path: string): void {
  stack.value = [...stack.value, path];
  void load();
}
function back(): void {
  stack.value = stack.value.slice(0, -1);
  void load();
}
function toggle(entry: Entry): void {
  const next = new Map(selected.value);
  if (next.has(entry.path)) next.delete(entry.path);
  else if (next.size < 100) next.set(entry.path, entry);
  else {
    error.value = "一次最多选择 100 个文件";
    return;
  }
  selected.value = next;
}
async function upload(): Promise<void> {
  if (uploading.value || !account.session || !selected.value.size) return;
  const identity = `${account.status?.baseUrl}/${account.session.user.id}/${account.session.device.id}`;
  uploading.value = true;
  error.value = "";
  const files = [...selected.value.values()];
  let done = 0;
  try {
    for (const file of files) {
      if (identity !== `${account.status?.baseUrl}/${account.session?.user.id}/${account.session?.device.id}`)
        throw new Error("账号已切换，上传已停止");
      progress.value = `正在上传 ${done + 1}/${files.length}：${file.name}`;
      await cloudUpload(file.path, props.kind);
      const next = new Map(selected.value);
      next.delete(file.path);
      selected.value = next;
      done += 1;
      emit("uploaded");
    }
    progress.value = `已上传 ${done} 个文件`;
    emit("update:open", false);
  } catch (cause) {
    error.value = cloudError(cause);
    progress.value = `已上传 ${done}/${files.length} 个文件，未完成的文件可重试。`;
  } finally {
    uploading.value = false;
  }
}
function setOpen(open: boolean): void {
  if (!uploading.value) emit("update:open", open);
}
</script>

<template>
  <Dialog :open="open" @update:open="setOpen">
    <DialogContent
      :show-close-button="!uploading"
      class="flex max-h-[80vh] flex-col border-line bg-panel sm:max-w-[620px]"
      data-testid="cloud-upload-dialog"
    >
      <DialogTitle>上传到{{ kind === "library" ? "资料库" : "网盘" }}</DialogTitle>
      <DialogDescription>选择工作区文件，上传到当前账号的私有空间。本地文件不会被移动或删除。</DialogDescription>
      <div class="flex items-center gap-2">
        <button :disabled="!stack.length || uploading" class="shrink-0 text-[12px] text-cyan disabled:opacity-40" @click="back">
          上一级
        </button>
        <p class="truncate font-mono text-[11px] text-dim2" :title="directory">{{ directory }}</p>
      </div>
      <p v-if="!account.session" class="text-[12px] text-dim">请先登录服务器账号。</p>
      <p v-if="error" role="alert" class="text-[12px] text-red-400">{{ error }}</p>
      <div class="min-h-[120px] overflow-y-auto rounded-[calc(6px*var(--gw-radius-scale))] border border-line">
        <p v-if="loading" class="p-4 text-[12px] text-dim">正在读取目录…</p>
        <p v-else-if="!entries.length" class="p-4 text-[12px] text-dim">此目录没有文件。</p>
        <ul v-else class="divide-y divide-line">
          <li v-for="entry in sortedEntries" :key="entry.path" class="px-3 py-2 text-[12px]">
            <button
              v-if="entry.kind === 'directory'"
              class="w-full truncate text-left text-cyan disabled:opacity-40"
              :disabled="uploading"
              @click="enter(entry.path)"
            >
              {{ entry.name }}/
            </button>
            <label v-else class="flex cursor-pointer items-center gap-2 text-foreground">
              <input type="checkbox" :checked="selected.has(entry.path)" :disabled="uploading" @change="toggle(entry)" />
              <span class="min-w-0 flex-1 truncate">{{ entry.name }}</span
              ><span class="text-[11px] text-dim2">{{ formatCloudBytes(entry.size ?? 0) }}</span>
            </label>
          </li>
        </ul>
      </div>
      <p v-if="progress" role="status" aria-live="polite" class="text-[12px] text-dim">{{ progress }}</p>
      <footer class="flex items-center justify-between gap-3">
        <span class="text-[12px] text-dim2">已选 {{ selected.size }} 个文件</span>
        <button
          class="rounded-[calc(6px*var(--gw-radius-scale))] bg-cyan/15 px-4 py-2 text-[12px] text-cyan disabled:opacity-40"
          :disabled="!selected.size || uploading || !account.session"
          @click="upload"
        >
          {{ uploading ? "上传中…" : "上传文件" }}
        </button>
      </footer>
    </DialogContent>
  </Dialog>
</template>
