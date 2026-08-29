<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { isTauriRuntime } from "@greywork/core";
import { useI18n } from "vue-i18n";
import { FilePlus, FolderOpen, FolderPlus, Plus, SquarePen, Trash2 } from "lucide-vue-next";
import { Button, Dialog, Input } from "../components/ui";
import { appEvents } from "../events";
import {
  MAX_IMPORT_FILES,
  isTextFile,
  pickWorkspaceDirectory,
  pickWorkspaceFiles,
  readTextFile,
  writeTextFile,
  type WorkspaceFileSource,
} from "../state/workspaceFiles";
import { useSessionStore } from "../stores/session";
import { useVfsStore } from "../stores/vfs";
import { useWorkspaceStore, type WorkspaceFile, type WorkspaceRecord } from "../stores/workspace";

const { t } = useI18n();
const workspaceStore = useWorkspaceStore();
const sessionStore = useSessionStore();
const vfs = useVfsStore();
const router = useRouter();

const vfsPathOf = (workspace: WorkspaceRecord, name: string): string => `workspaces/${workspace.id}/${name}`;

/* ── 新建工作区 ── */
const createOpen = ref(false);
const newName = ref("");
const newDesc = ref("");
function confirmCreate(): void {
  const name = newName.value.trim();
  if (!name) return;
  const workspace = workspaceStore.createWorkspace(name, newDesc.value);
  newName.value = "";
  newDesc.value = "";
  createOpen.value = false;
  importHint.value = t("workspaces.createdHint", { name: workspace.name });
}

/* ── 重命名 ── */
const renameOpen = ref(false);
const renameId = ref("");
const renameName = ref("");
function startRename(workspace: WorkspaceRecord): void {
  renameId.value = workspace.id;
  renameName.value = workspace.name;
  renameOpen.value = true;
}
function confirmRename(): void {
  workspaceStore.renameWorkspace(renameId.value, renameName.value);
  renameOpen.value = false;
}

/* ── 删除（两段确认）── */
const deleteConfirmId = ref("");
let deleteTimer: ReturnType<typeof setTimeout> | null = null;
function requestDelete(workspace: WorkspaceRecord): void {
  if (deleteConfirmId.value === workspace.id) {
    // 工作区删除不连带会话：会话迁移到普通对话
    sessionStore.reassignWorkspace(workspace.id, null);
    workspaceStore.deleteWorkspace(workspace.id);
    deleteConfirmId.value = "";
    return;
  }
  deleteConfirmId.value = workspace.id;
  if (deleteTimer) clearTimeout(deleteTimer);
  deleteTimer = setTimeout(() => (deleteConfirmId.value = ""), 2500);
}

/* ── 文件存放 ── */
const importingMap = ref<Record<string, boolean>>({});
const importHint = ref("");
function isImporting(workspaceId: string): boolean {
  return importingMap.value[workspaceId] ?? false;
}

/** 打开文件 → 读取内容 → 存放（桌面端写入工作区文件夹 / 原路径）→ 登记并打开编辑器。 */
async function openFiles(workspace: WorkspaceRecord): Promise<void> {
  const picked = await pickWorkspaceFiles(true);
  if (picked.length) await storeSources(workspace, picked);
}

/** 选择存放文件夹 → 绑定 → 扫描目录内容登记为工作区文件。 */
async function chooseFolder(workspace: WorkspaceRecord): Promise<void> {
  const dir = await pickWorkspaceDirectory();
  if (!dir) return;
  importingMap.value[workspace.id] = true;
  try {
    workspaceStore.setFolder(workspace.id, dir.path);
    let registered = 0;
    for (const entry of dir.entries.filter((candidate) => candidate.kind === "file").slice(0, MAX_IMPORT_FILES)) {
      const isText = isTextFile(entry.name, entry.size);
      const extension = {
        name: entry.name,
        vfsPath: vfsPathOf(workspace, entry.name),
        kind: "file" as const,
        size: entry.size,
        origin: entry.origin,
        binary: !isText,
      };
      workspaceStore.addFile(workspace.id, extension);
      // 浏览器端 webkitdirectory：目录扫描即加载文本内容进内存工作区
      if (!isTauriRuntime() && isText) {
        try {
          const content = await entry.readText();
          await vfs.write(extension.vfsPath, content);
        } catch {
          /* 单个文件读取失败不影响其余登记 */
        }
      }
      registered += 1;
    }
    importHint.value = t("workspaces.folderBoundHint", { folder: dir.path, count: registered });
  } finally {
    importingMap.value[workspace.id] = false;
  }
}

async function storeSources(workspace: WorkspaceRecord, sources: WorkspaceFileSource[]): Promise<void> {
  importingMap.value[workspace.id] = true;
  let loaded = 0;
  let skipped = 0;
  let firstPath = "";
  for (const source of sources.slice(0, MAX_IMPORT_FILES)) {
    if (!isTextFile(source.name, source.size)) {
      skipped += 1;
      continue;
    }
    try {
      const content = await source.readText();
      const vfsPath = vfsPathOf(workspace, source.name);
      // 有存放文件夹（桌面端）：把文件内容存放进该文件夹，origin 指向文件夹内
      const destOrigin = workspace.folder && isTauriRuntime() ? `${workspace.folder}/${source.name}` : source.origin;
      if (destOrigin && isTauriRuntime()) await writeTextFile(destOrigin, content);
      await vfs.write(vfsPath, content);
      workspaceStore.addFile(workspace.id, {
        name: source.name,
        vfsPath,
        kind: "file",
        size: source.size,
        origin: destOrigin,
        binary: false,
      });
      loaded += 1;
      firstPath ||= vfsPath;
    } catch {
      skipped += 1;
    }
  }
  importingMap.value[workspace.id] = false;
  if (firstPath) {
    await vfs.open(firstPath);
    appEvents.emit("editor:open", { path: firstPath });
    importHint.value = t("workspaces.storedHint", { count: loaded, skipped });
  } else {
    importHint.value = t("workspaces.noTextLoaded");
  }
}

/** 点击文件：从磁盘路径读最新内容再打开（未绑定磁盘源则直接用内存工作区内容）。 */
async function openFile(file: WorkspaceFile): Promise<void> {
  if (file.kind === "directory") return;
  if (file.binary || !isTextFile(file.name, file.size)) {
    importHint.value = t("workspaces.binaryHint", { name: file.name });
    return;
  }
  try {
    if (file.origin && isTauriRuntime()) {
      const content = await readTextFile(file.origin);
      await vfs.write(file.vfsPath, content);
    }
    await vfs.open(file.vfsPath);
    appEvents.emit("editor:open", { path: file.vfsPath });
    importHint.value = "";
  } catch (error) {
    importHint.value = t("workspaces.readFailed", { detail: error instanceof Error ? error.message : String(error) });
  }
}

async function goChat(workspace: WorkspaceRecord): Promise<void> {
  workspaceStore.setActiveWorkspace(workspace.id);
  await router.push(`/p/${workspace.id}/chat`);
}
</script>

<template>
  <section class="view" data-testid="workspaces-view">
    <div class="view__head">
      <div>
        <p class="view__eyebrow">WORKSPACES</p>
        <h1 class="view__title">{{ t("workspaces.title") }}</h1>
        <p class="view__sub">{{ t("workspaces.sub") }}</p>
      </div>
      <div class="view__actions">
        <Button size="sm" @click="createOpen = true"><Plus class="size-3.5" />{{ t("workspaces.create") }}</Button>
      </div>
    </div>

    <p v-if="importHint" class="workspaces-hint" role="status">{{ importHint }}</p>

    <div v-if="workspaceStore.workspaces.length" class="workspaces-grid">
      <div v-for="workspace in workspaceStore.workspaces" :key="workspace.id" class="panel workspace-card">
        <div class="panel__head">
          <span class="panel__title">{{ workspace.name }}</span>
          <span v-if="workspace.id === workspaceStore.activeWorkspaceId" class="workspace-card__active">{{
            t("workspaces.activeBadge")
          }}</span>
          <span class="panel__meta">{{ t("workspaces.fileCount", { count: workspace.files.length }) }}</span>
        </div>
        <p class="workspace-card__desc">{{ workspace.description || t("workspaces.noDesc") }}</p>
        <p v-if="workspace.folder" class="workspace-card__folder" :title="workspace.folder">{{ workspace.folder }}</p>
        <p v-else class="workspace-card__folder workspace-card__folder--empty">{{ t("workspaces.noFolder") }}</p>
        <p v-if="isImporting(workspace.id)" class="workspace-card__importing">{{ t("workspaces.importing") }}</p>
        <div v-if="workspace.files.length" class="workspace-card__files" :aria-label="t('workspaces.filesLabel', { name: workspace.name })">
          <button
            v-for="file in workspace.files"
            :key="file.vfsPath"
            class="workspace-card__file"
            :class="{ 'workspace-card__file--binary': file.binary || !isTextFile(file.name, file.size) }"
            :title="file.vfsPath"
            @click="openFile(file)"
          >
            {{ file.name }}
          </button>
        </div>
        <p v-else class="workspace-card__empty">{{ t("workspaces.noFiles") }}</p>
        <div class="workspace-card__actions">
          <Button size="sm" :variant="workspace.id === workspaceStore.activeWorkspaceId ? 'ghost' : 'default'" @click="goChat(workspace)">
            {{ t("workspaces.setActive") }}
          </Button>
          <Button size="sm" variant="outline" @click="chooseFolder(workspace)">
            <FolderOpen class="size-3.5" />{{ t("workspaces.chooseFolder") }}
          </Button>
          <Button size="sm" variant="outline" @click="openFiles(workspace)">
            <FilePlus class="size-3.5" />{{ t("workspaces.openFile") }}
          </Button>
          <Button size="sm" variant="ghost" @click="startRename(workspace)">
            <SquarePen class="size-3.5" />{{ t("workspaces.rename") }}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            :title="deleteConfirmId === workspace.id ? t('workspaces.deleteConfirm') : undefined"
            @click="requestDelete(workspace)"
          >
            <Trash2 class="size-3.5" />
            {{ deleteConfirmId === workspace.id ? t("workspaces.deleteConfirmShort") : t("common.delete") }}
          </Button>
        </div>
      </div>
    </div>
    <div v-else class="panel workspaces-empty">
      <FolderPlus class="size-6" />
      <p>{{ t("workspaces.empty") }}</p>
      <Button size="sm" @click="createOpen = true"><Plus class="size-3.5" />{{ t("workspaces.create") }}</Button>
    </div>

    <Dialog :open="createOpen" @update:open="createOpen = $event">
      <p class="dialog-title">{{ t("workspaces.createTitle") }}</p>
      <label class="dialog-field">
        <span>{{ t("workspaces.nameLabel") }}</span>
        <Input v-model="newName" :placeholder="t('workspaces.namePlaceholder')" @keydown.enter="confirmCreate" />
      </label>
      <label class="dialog-field">
        <span>{{ t("workspaces.descLabel") }}</span>
        <Input v-model="newDesc" :placeholder="t('workspaces.descPlaceholder')" @keydown.enter="confirmCreate" />
      </label>
      <div class="dialog-actions">
        <Button variant="ghost" size="sm" @click="createOpen = false">{{ t("common.cancel") }}</Button>
        <Button size="sm" :disabled="!newName.trim()" @click="confirmCreate">{{ t("common.ok") }}</Button>
      </div>
    </Dialog>

    <Dialog :open="renameOpen" @update:open="renameOpen = $event">
      <p class="dialog-title">{{ t("workspaces.renameTitle") }}</p>
      <label class="dialog-field">
        <span>{{ t("workspaces.nameLabel") }}</span>
        <Input v-model="renameName" @keydown.enter="confirmRename" />
      </label>
      <div class="dialog-actions">
        <Button variant="ghost" size="sm" @click="renameOpen = false">{{ t("common.cancel") }}</Button>
        <Button size="sm" :disabled="!renameName.trim()" @click="confirmRename">{{ t("common.ok") }}</Button>
      </div>
    </Dialog>
  </section>
</template>

<style scoped>
.workspaces-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
  align-items: start;
}
.workspace-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
}
.workspace-card__active {
  color: var(--mint);
  font-family: var(--font-mono);
  font-size: 10px;
}
.workspace-card__desc {
  margin: 0;
  color: var(--dim2);
  font-size: 12px;
}
.workspace-card__folder {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dim2);
  font-family: var(--font-mono);
  font-size: 11px;
}
.workspace-card__folder--empty {
  color: var(--dim2);
  font-style: italic;
}
.workspace-card__importing {
  margin: 0;
  color: var(--accent);
  font-size: 12px;
}
.workspace-card__files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.workspace-card__file {
  max-width: 100%;
  overflow: hidden;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-1);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.workspace-card__file:hover {
  border-color: var(--accent);
}
.workspace-card__file--binary {
  color: var(--dim2);
  cursor: default;
  border-color: transparent;
}
.workspace-card__empty {
  margin: 0;
  color: var(--dim2);
  font-size: 12px;
}
.workspace-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: auto;
}
.workspaces-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px;
  color: var(--dim2);
}
.workspaces-hint {
  margin: 0 0 10px;
  color: var(--mint);
  font-size: 12px;
}
.dialog-title {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
}
.dialog-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
  color: var(--dim2);
  font-size: 12px;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
</style>
