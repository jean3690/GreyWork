import { createJsonStorage } from "@greywork/core";
import { isTauriRuntime } from "@greywork/core";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { MOCK_WORKSPACES } from "../mocks/workspaces";
import { writeTextFile } from "../state/workspaceFiles";
import type { Workspace } from "../types";
import { setDiskWriter } from "./vfs";

/** 已打开文件条目：vfsPath 为编辑器工作区路径（workspaces/<id>/...），origin 为磁盘存放路径（仅桌面端）。 */
export interface WorkspaceFile {
  name: string;
  vfsPath: string;
  kind: "file" | "directory";
  size?: number;
  /** 磁盘存放路径（工作区文件夹内或原文件位置）。 */
  origin?: string;
  /** 二进制文件：仅记录不预览。 */
  binary?: boolean;
}

/** 工作区记录：绑定用户选择的存放文件夹 + 已打开（存放）文件清单。 */
export interface WorkspaceRecord extends Workspace {
  /** 用户选择的存放文件夹（桌面端为磁盘路径，浏览器端为所选文件夹名）。 */
  folder?: string;
  files: WorkspaceFile[];
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = "greywork.workspaces";
const LEGACY_PROJECTS_KEY = "greywork.projects";

interface PersistedWorkspaces {
  version: 1;
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string | null;
}

function isWorkspaceFile(value: unknown): value is WorkspaceFile {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" && typeof record.vfsPath === "string" && (record.kind === "file" || record.kind === "directory");
}

function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.description === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number" &&
    Array.isArray(record.files) &&
    record.files.every(isWorkspaceFile) &&
    (record.folder === undefined || typeof record.folder === "string")
  );
}

function isPersistedWorkspaces(value: unknown): value is PersistedWorkspaces {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    Array.isArray(record.workspaces) &&
    record.workspaces.every(isWorkspaceRecord) &&
    (record.activeWorkspaceId === null || typeof record.activeWorkspaceId === "string")
  );
}

/** 旧版「项目」存储（greywork.projects）→ 工作区：root 即存放文件夹，其余字段同构。 */
interface LegacyProjects {
  version: 1;
  projects: Array<{
    id: string;
    name: string;
    description: string;
    root?: string;
    files?: unknown[];
    createdAt: number;
    updatedAt: number;
  }>;
  activeProjectId: string | null;
}

function readLegacyProjects(): PersistedWorkspaces | null {
  const legacy = createJsonStorage<LegacyProjects>(
    LEGACY_PROJECTS_KEY,
    (value): value is LegacyProjects =>
      typeof value === "object" && value !== null && Array.isArray((value as { projects?: unknown }).projects),
  ).read();
  if (!legacy) return null;
  return {
    version: 1,
    workspaces: legacy.projects.map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      folder: project.root,
      files: Array.isArray(project.files)
        ? (project.files.filter(isWorkspaceFile).map((file) => ({
            ...file,
            // 旧路径 projects/<id>/… → 工作区路径 workspaces/<id>/…
            vfsPath: file.vfsPath.startsWith(`projects/${project.id}/`)
              ? file.vfsPath.replace(`projects/${project.id}/`, `workspaces/${project.id}/`)
              : file.vfsPath,
          })) as WorkspaceFile[])
        : [],
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })),
    activeWorkspaceId: legacy.activeProjectId,
  };
}

const storage = createJsonStorage<PersistedWorkspaces>(STORAGE_KEY, isPersistedWorkspaces);

/** 移除给定 key（迁移完成后清理旧版数据）。 */
function removeStorageValue(key: string): void {
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.removeItem(key);
    return;
  }
  const storageHolder = globalThis as { localStorage?: Storage };
  storageHolder.localStorage?.removeItem(key);
}

function seedWorkspaces(): WorkspaceRecord[] {
  const now = Date.now();
  return MOCK_WORKSPACES.map((workspace, index) => ({
    ...workspace,
    files: [],
    createdAt: now - (MOCK_WORKSPACES.length - index) * 86_400_000,
    updatedAt: now - (MOCK_WORKSPACES.length - index) * 86_400_000,
  }));
}

let workspaceSeq = 0;
function makeId(): string {
  workspaceSeq += 1;
  return `w-${Date.now().toString(36)}-${workspaceSeq}`;
}

/** 工作区（绑定存放文件夹）与已存放文件的顶层组织。持久化于 localStorage（greywork.workspaces）。 */
export const useWorkspaceStore = defineStore("workspace", () => {
  const stored = storage.read();
  const legacy = stored ?? readLegacyProjects();
  // 旧版 key 读取后即清理（无论是否走迁移路径），避免遗留数据二次迁移
  removeStorageValue(LEGACY_PROJECTS_KEY);
  const workspaces = ref<WorkspaceRecord[]>(legacy?.workspaces ?? seedWorkspaces());
  const activeWorkspaceId = ref<string | null>(legacy?.activeWorkspaceId ?? workspaces.value[0]?.id ?? null);

  function persist(): void {
    storage.write({ version: 1, workspaces: workspaces.value, activeWorkspaceId: activeWorkspaceId.value });
  }

  /* 编辑器保存 → 同步写回存放文件夹（仅桌面端命中 origin 的文件）。 */
  let writerBound = false;
  function bindDiskWriter(): void {
    if (writerBound) return;
    writerBound = true;
    setDiskWriter(async (vfsPath, content) => {
      if (!isTauriRuntime()) return;
      for (const workspace of workspaces.value) {
        const file = workspace.files.find((candidate) => candidate.vfsPath === vfsPath && candidate.origin);
        if (file?.origin) {
          await writeTextFile(file.origin, content);
          return;
        }
      }
    });
  }
  bindDiskWriter();

  function workspaceById(id: string | null): WorkspaceRecord | undefined {
    if (!id) return undefined;
    return workspaces.value.find((workspace) => workspace.id === id);
  }

  function workspaceByName(name: string): WorkspaceRecord | undefined {
    return workspaces.value.find((workspace) => workspace.name === name || workspace.id === name);
  }

  function setActiveWorkspace(id: string): void {
    activeWorkspaceId.value = id;
    persist();
  }

  function createWorkspace(name: string, description = ""): WorkspaceRecord {
    const now = Date.now();
    const workspace: WorkspaceRecord = {
      id: makeId(),
      name: name.trim(),
      description: description.trim(),
      files: [],
      createdAt: now,
      updatedAt: now,
    };
    workspaces.value.push(workspace);
    activeWorkspaceId.value = workspace.id;
    persist();
    return workspace;
  }

  function renameWorkspace(id: string, name: string): void {
    const workspace = workspaceById(id);
    const trimmed = name.trim();
    if (!workspace || !trimmed) return;
    workspace.name = trimmed;
    workspace.updatedAt = Date.now();
    persist();
  }

  function updateDescription(id: string, description: string): void {
    const workspace = workspaceById(id);
    if (!workspace) return;
    workspace.description = description.trim();
    workspace.updatedAt = Date.now();
    persist();
  }

  /** 删除工作区；其会话由调用方（sessionStore.reassignWorkspace）迁移到普通对话。 */
  function deleteWorkspace(id: string): void {
    const index = workspaces.value.findIndex((workspace) => workspace.id === id);
    if (index < 0) return;
    workspaces.value.splice(index, 1);
    if (activeWorkspaceId.value === id) activeWorkspaceId.value = workspaces.value[0]?.id ?? null;
    persist();
  }

  /** 绑定用户选择的存放文件夹。 */
  function setFolder(id: string, folder: string): void {
    const workspace = workspaceById(id);
    if (!workspace) return;
    workspace.folder = folder;
    workspace.updatedAt = Date.now();
    persist();
  }

  /** 登记已存放（打开）文件（同 vfsPath 去重）。 */
  function addFile(id: string, entry: WorkspaceFile): void {
    const workspace = workspaceById(id);
    if (!workspace) return;
    const index = workspace.files.findIndex((candidate) => candidate.vfsPath === entry.vfsPath);
    if (index >= 0) workspace.files[index] = entry;
    else workspace.files.push(entry);
    workspace.updatedAt = Date.now();
    persist();
  }

  function removeFile(id: string, vfsPath: string): void {
    const workspace = workspaceById(id);
    if (!workspace) return;
    workspace.files = workspace.files.filter((candidate) => candidate.vfsPath !== vfsPath);
    workspace.updatedAt = Date.now();
    persist();
  }

  return {
    workspaces,
    activeWorkspaceId,
    workspaceById,
    workspaceByName,
    setActiveWorkspace,
    createWorkspace,
    renameWorkspace,
    updateDescription,
    deleteWorkspace,
    setFolder,
    addFile,
    removeFile,
    persist,
  };
});

/** 当前激活工作区（跨 store 派生，供 TopBar 面包屑使用）。 */
export function useActiveWorkspaceResolver() {
  const workspaceStore = useWorkspaceStore();
  return computed(() => workspaceStore.workspaces.find((workspace) => workspace.id === workspaceStore.activeWorkspaceId) ?? null);
}
