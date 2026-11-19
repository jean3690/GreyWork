<script setup lang="ts">
import { onUnmounted, shallowRef, watch } from "vue";
import { type CloudTask, type CloudTaskInput } from "@/lib/cloud-api";
import { useCloudTasks } from "./useCloudTasks";
import CloudTaskForm from "./CloudTaskForm.vue";
import CloudTaskList from "./CloudTaskList.vue";
import ConfirmDialog from "@/features/settings/ConfirmDialog.vue";
import { pendingCloudTaskDraft, type CloudTaskDraft } from "./task-draft";
const { tasks, runs, hosts, zone, loading, saving, error, refresh, save, remove, setEnabled } = useCloudTasks();
const editor = shallowRef<{ task: CloudTask | null; draft: CloudTaskDraft | null; key: number } | null>(null);
let editorSequence = 0;
function openEditor(task: CloudTask | null, draft: CloudTaskDraft | null = null): void {
  editor.value = { task, draft, key: ++editorSequence };
}
const deleting = shallowRef<CloudTask | null>(null);
watch(
  [zone, pendingCloudTaskDraft],
  ([value, draft]) => {
    if (value && draft) openEditor(null, draft);
  },
  { immediate: true },
);
const timer = setInterval(() => {
  if (!saving.value && !editor.value) void refresh();
}, 30_000);
onUnmounted(() => clearInterval(timer));
async function submit(input: CloudTaskInput): Promise<void> {
  const submitted = editor.value;
  if (!submitted) return;
  const task = await save(submitted.task?.id ?? null, input);
  if (task) {
    submitted.draft?.onCreated(task.id);
    if (pendingCloudTaskDraft.value === submitted.draft) pendingCloudTaskDraft.value = null;
    if (editor.value === submitted) editor.value = null;
  }
}
function cancelEdit(): void {
  if (pendingCloudTaskDraft.value === editor.value?.draft) pendingCloudTaskDraft.value = null;
  editor.value = null;
}
function confirmDelete(): void {
  const task = deleting.value;
  deleting.value = null;
  if (task) void remove(task.id);
}
const statuses: Record<string, string> = { ok: "成功", failed: "失败", skipped: "已跳过", running: "执行中" };
</script>

<template>
  <div class="mx-auto max-w-[900px]">
    <header class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-[16px] font-semibold text-foreground">云端定时任务</h2>
        <p class="mt-1 text-[12px] text-dim">服务器排期，设备执行，结果回传。{{ zone ? `调度时区：${zone}` : "" }}</p>
      </div>
      <div class="flex gap-2">
        <button
          class="rounded-[calc(6px*var(--gw-radius-scale))] border border-line px-3 py-1.5 text-[12px] text-dim"
          :disabled="loading"
          @click="refresh"
        >
          刷新</button
        ><button
          class="rounded-[calc(6px*var(--gw-radius-scale))] bg-cyan/15 px-3 py-1.5 text-[12px] text-cyan"
          :disabled="saving || !zone"
          @click="openEditor(null)"
        >
          新建任务
        </button>
      </div>
    </header>
    <p v-if="error" role="alert" class="mb-3 text-[12px] text-red-400">{{ error }}</p>
    <CloudTaskForm
      v-if="editor"
      :key="editor.key"
      :task="editor.task"
      :draft="editor.draft"
      :hosts="hosts"
      :zone="zone"
      :saving="saving"
      @save="submit"
      @cancel="cancelEdit"
    />
    <CloudTaskList :tasks="tasks" :saving="saving" @edit="openEditor($event)" @toggle="setEnabled" @remove="deleting = $event" />
    <h3 class="mb-3 mt-6 text-[14px] font-semibold text-foreground">最近运行记录</h3>
    <p v-if="!runs.length" class="text-[12px] text-dim">暂无运行记录。</p>
    <ul v-else class="divide-y divide-line">
      <li v-for="run in runs" :key="run.id" class="py-3">
        <div class="flex gap-3 text-[12px]">
          <span class="min-w-0 flex-1 truncate text-foreground">{{ run.name }}</span
          ><span :class="run.status === 'failed' ? 'text-red-400' : 'text-dim'">{{ statuses[run.status] ?? run.status }}</span>
        </div>
        <p class="mt-1 text-[11px] text-dim2">{{ run.finishedAt?.replace("T", " ") }} · {{ run.detail }}</p>
        <details v-if="run.output" class="mt-2 text-[12px] text-dim">
          <summary class="cursor-pointer">查看输出</summary>
          <pre
            class="mt-2 max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-[calc(6px*var(--gw-radius-scale))] bg-panel p-3 text-[12px] text-foreground"
            >{{ run.output }}</pre>
        </details>
      </li>
    </ul>
    <ConfirmDialog
      v-if="deleting"
      title="删除云端任务"
      :message="`确定删除「${deleting.name}」？尚未执行的到期任务也会取消。`"
      confirm-label="删除"
      @confirm="confirmDelete"
      @cancel="deleting = null"
    />
  </div>
</template>
