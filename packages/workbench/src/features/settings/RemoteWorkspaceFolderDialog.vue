<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { isTauriRuntime } from "@greywork/core";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import Icon from "@/features/shared/Icon.vue";
import { bindWorkspaceFolder } from "@/lib/workspace-bind";
import {
  defaultRemoteWorkspaceFolder,
  ensureRemoteWorkspace,
  ensureRemoteWorkspaceFolder,
  REMOTE_WORKSPACE_ID,
} from "@/lib/remote-workspace";
import { pickWorkspaceFolder } from "@/lib/workspace-picker";
import { ensureDir } from "@/state/workspaceFiles";
import { useWorkspaceStore } from "@/stores/workspace";
import { notify } from "@/stores/notice";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const workspaceStore = useWorkspaceStore();
const busy = ref(false);
const defaultFolder = ref<string | null>(null);

const workspace = computed(() => workspaceStore.workspaceById(REMOTE_WORKSPACE_ID) ?? null);
const folder = computed(() => workspace.value?.folder ?? defaultFolder.value ?? t("remoteAssist.workspace.folderDefault"));

async function prepare(): Promise<void> {
  ensureRemoteWorkspace(workspaceStore);
  defaultFolder.value = await defaultRemoteWorkspaceFolder().catch(() => null);
  await ensureRemoteWorkspaceFolder(workspaceStore).catch((error: unknown) => {
    console.warn("[remote-assistant] 远程工作区文件夹未就绪", error);
  });
}

async function changeFolder(): Promise<void> {
  if (busy.value || !isTauriRuntime()) return;
  const selected = await pickWorkspaceFolder();
  if (!selected || selected === workspace.value?.folder) return;
  busy.value = true;
  try {
    const result = await bindWorkspaceFolder(REMOTE_WORKSPACE_ID, selected);
    notify({
      kind: "success",
      key: "remote-workspace-folder",
      title: t("remoteAssist.workspace.folderChanged", { count: result.moved }),
      detail: selected,
    });
  } catch (error) {
    notify({ kind: "error", key: "remote-workspace-folder", title: t("remoteAssist.workspace.folderFailed"), detail: String(error) });
  } finally {
    busy.value = false;
  }
}

async function resetFolder(): Promise<void> {
  if (busy.value || !isTauriRuntime()) return;
  busy.value = true;
  try {
    const selected = await defaultRemoteWorkspaceFolder();
    await ensureDir(selected);
    const result = await bindWorkspaceFolder(REMOTE_WORKSPACE_ID, selected);
    notify({
      kind: "success",
      key: "remote-workspace-folder",
      title: t("remoteAssist.workspace.folderChanged", { count: result.moved }),
      detail: selected,
    });
  } catch (error) {
    notify({ kind: "error", key: "remote-workspace-folder", title: t("remoteAssist.workspace.folderFailed"), detail: String(error) });
  } finally {
    busy.value = false;
  }
}

function onOpenChange(next: boolean): void {
  if (!next) emit("close");
}

onMounted(() => {
  void prepare();
});
</script>

<template>
  <Dialog :open="props.open" @update:open="onOpenChange">
    <DialogContent
      :show-close-button="false"
      class="flex max-h-[88vh] flex-col gap-0 overflow-hidden rounded-[14px] border-line bg-panel p-0 shadow-xl sm:max-w-[520px]"
      data-testid="remote-workspace-folder-dialog"
    >
      <div class="flex items-center justify-between px-4 pb-2 pt-3.5">
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="grid size-7 shrink-0 place-items-center rounded-[8px] border border-line bg-panel-2 text-dim">
            <Icon name="folder" :size="14" />
          </span>
          <div class="min-w-0">
            <DialogTitle class="text-[13px] font-medium text-foreground">{{ t("remoteAssist.workspace.dialogTitle") }}</DialogTitle>
            <DialogDescription class="mt-0.5 text-[10.5px] leading-relaxed text-dim2">
              {{ t("remoteAssist.workspace.dialogHint") }}
            </DialogDescription>
          </div>
        </div>
        <button
          type="button"
          class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[6px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
          aria-label="关闭"
          @click="emit('close')"
        >
          <Icon name="close" :size="13" />
        </button>
      </div>

      <div class="space-y-3 px-4 pb-4 pt-1">
        <p
          class="break-all rounded-[10px] border border-line bg-panel-2 px-3 py-2 font-mono text-[10.5px] text-dim2"
          data-testid="remote-workspace-folder-path"
        >
          {{ folder }}
        </p>
        <p v-if="!isTauriRuntime()" class="text-[10.5px] text-dim2">{{ t("remoteAssist.workspace.desktopOnly") }}</p>
        <div class="flex gap-2">
          <button
            type="button"
            class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel-2 px-2.5 text-[11.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="busy || !isTauriRuntime()"
            data-testid="remote-workspace-folder-change"
            @click="changeFolder"
          >
            {{ t("remoteAssist.workspace.folderChange") }}
          </button>
          <button
            type="button"
            class="h-7 cursor-pointer rounded-[7px] border border-line bg-panel-2 px-2.5 text-[11.5px] text-dim transition-colors hover:border-line-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="busy || !isTauriRuntime()"
            data-testid="remote-workspace-folder-reset"
            @click="resetFolder"
          >
            {{ t("remoteAssist.workspace.folderReset") }}
          </button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
