import { createJsonStorage } from "@greywork/core";
import { isTauriRuntime } from "@greywork/core";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
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

/**
 * 每工作区记忆的 ACP / agent 配置。
 *
 * 只记「用户选过什么」，不记运行期状态（handle / sessionId）：切回该工作区时
 * 按此重建，跨重启也成立。configValues 的键是 agent 在 session/new 暴露的
 * 配置项 id（model / effort / mode …），不同 agent 各异，故不写死字段。
 */
export interface WorkspaceAgentConfig {
  /** ACP provider id；null = 本地 LLM 管线；undefined = 未记录过。 */
  providerId?: string | null;
  /** 会话配置项 id → 选中值（模型、思考强度、会话模式等）。 */
  configValues?: Record<string, string>;
}

/** 工作区记录：绑定用户选择的存放文件夹 + 已打开（存放）文件清单。 */
export interface WorkspaceRecord extends Workspace {
  /** 用户选择的存放文件夹（桌面端为磁盘路径，浏览器端为所选文件夹名）。 */
  folder?: string;
  files: WorkspaceFile[];
  createdAt: number;
  updatedAt: number;
  /** 最近一次被激活的时刻（最近使用排序依据；v1 迁移时取 updatedAt）。 */
  lastUsedAt: number;
  /** 该工作区记住的 ACP / agent 配置。 */
  agentConfig?: WorkspaceAgentConfig;
  /** 侧栏展示图标（Icon 名）；缺省按「普通对话 / 工作区」兜底。 */
  icon?: string;
}

const STORAGE_KEY = "greywork.workspaces";
const LEGACY_PROJECTS_KEY = "greywork.projects";

/** v2：新增 lastUsedAt（最近使用）与 defaultWorkspaceId（默认工作区）。 */
interface PersistedWorkspaces {
  version: 2;
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string | null;
  /** 启动时的兜底工作区（用户显式设定）；null = 不指定，按最近使用。 */
  defaultWorkspaceId: string | null;
}

/** v1：无 lastUsedAt / defaultWorkspaceId，读取时补齐。 */
interface PersistedWorkspacesV1 {
  version: 1;
  workspaces: Omit<WorkspaceRecord, "lastUsedAt">[];
  activeWorkspaceId: string | null;
}

function isWorkspaceFile(value: unknown): value is WorkspaceFile {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" && typeof record.vfsPath === "string" && (record.kind === "file" || record.kind === "directory");
}

/** v1/v2 共有字段的校验（lastUsedAt 单独判，v1 记录没有它）。 */
function hasWorkspaceCore(value: unknown): value is Omit<WorkspaceRecord, "lastUsedAt"> {
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
    (record.folder === undefined || typeof record.folder === "string") &&
    (record.icon === undefined || typeof record.icon === "string")
  );
}

function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  if (!hasWorkspaceCore(value)) return false;
  return "lastUsedAt" in value && typeof value.lastUsedAt === "number";
}

function isPersistedWorkspaces(value: unknown): value is PersistedWorkspaces {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 2 &&
    Array.isArray(record.workspaces) &&
    record.workspaces.every(isWorkspaceRecord) &&
    (record.activeWorkspaceId === null || typeof record.activeWorkspaceId === "string") &&
    (record.defaultWorkspaceId === null || typeof record.defaultWorkspaceId === "string")
  );
}

function isPersistedWorkspacesV1(value: unknown): value is PersistedWorkspacesV1 {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && Array.isArray(record.workspaces) && record.workspaces.every(hasWorkspaceCore);
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
    (value): value is LegacyProjects => typeof value === "object" && value !== null && "projects" in value && Array.isArray(value.projects),
  ).read();
  if (!legacy) return null;
  return {
    version: 2,
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
      lastUsedAt: project.updatedAt,
    })),
    activeWorkspaceId: legacy.activeProjectId,
    defaultWorkspaceId: null,
  };
}

const storage = createJsonStorage<PersistedWorkspaces>(STORAGE_KEY, isPersistedWorkspaces);
const storageV1 = createJsonStorage<PersistedWorkspacesV1>(STORAGE_KEY, isPersistedWorkspacesV1);

/** 移除给定 key（迁移完成后清理旧版数据）。 */
function removeStorageValue(key: string): void {
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.removeItem(key);
    return;
  }
  const storageHolder = globalThis as { localStorage?: Storage };
  storageHolder.localStorage?.removeItem(key);
}

/**
 * v2 → 直接用；v1 → 补 lastUsedAt/defaultWorkspaceId；再旧 → 项目时代存储；
 * 都没有 → 空清单（首启不该出现用户从未创建的工作区；演示数据走 dev-only 注入）。
 */
function loadWorkspaces(): PersistedWorkspaces {
  const current = storage.read();
  if (current) return current;
  const v1 = storageV1.read();
  if (v1) {
    return {
      version: 2,
      // 没有使用记录可依据，退回 updatedAt：至少保住相对顺序
      workspaces: v1.workspaces.map((workspace) => ({ ...workspace, lastUsedAt: workspace.updatedAt })),
      activeWorkspaceId: v1.activeWorkspaceId,
      defaultWorkspaceId: null,
    };
  }
  return (
    readLegacyProjects() ?? {
      version: 2,
      workspaces: [],
      activeWorkspaceId: null,
      defaultWorkspaceId: null,
    }
  );
}

let workspaceSeq = 0;
function makeId(): string {
  workspaceSeq += 1;
  return `w-${Date.now().toString(36)}-${workspaceSeq}`;
}

/** 工作区（绑定存放文件夹）与已存放文件的顶层组织。持久化于 localStorage（greywork.workspaces）。 */
export const useWorkspaceStore = defineStore("workspace", () => {
  const loaded = loadWorkspaces();
  // 旧版 key 读取后即清理（无论是否走迁移路径），避免遗留数据二次迁移
  removeStorageValue(LEGACY_PROJECTS_KEY);
  const workspaces = ref<WorkspaceRecord[]>(loaded.workspaces);
  const defaultWorkspaceId = ref<string | null>(
    loaded.defaultWorkspaceId && loaded.workspaces.some((workspace) => workspace.id === loaded.defaultWorkspaceId)
      ? loaded.defaultWorkspaceId
      : null,
  );
  /** 最近使用优先（lastUsedAt 倒序）；同刻按原顺序稳定。 */
  const recentWorkspaces = computed(() => [...workspaces.value].sort((a, b) => b.lastUsedAt - a.lastUsedAt));
  /**
   * 启动落点：上次激活 → 默认工作区 → 清单首位。
   *
   * 最后一档刻意用声明顺序而不是最近使用：首启（种子数据）时「最近使用」是造出来的
   * 时间戳，落点会漂到列表末尾那个；上次激活本身已经承担了「回到我离开的地方」。
   */
  const activeWorkspaceId = ref<string | null>(loaded.activeWorkspaceId ?? defaultWorkspaceId.value ?? workspaces.value[0]?.id ?? null);

  function persist(): void {
    storage.write({
      version: 2,
      workspaces: workspaces.value,
      activeWorkspaceId: activeWorkspaceId.value,
      defaultWorkspaceId: defaultWorkspaceId.value,
    });
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

  /** 记一次使用（最近使用排序依据）；不动 updatedAt（那代表内容变更）。 */
  function touchWorkspace(id: string): void {
    const workspace = workspaceById(id);
    if (!workspace) return;
    workspace.lastUsedAt = Date.now();
    persist();
  }

  function setActiveWorkspace(id: string | null): void {
    activeWorkspaceId.value = id;
    const workspace = workspaceById(id);
    if (workspace) workspace.lastUsedAt = Date.now();
    persist();
  }

  /** 设为/取消默认工作区（下次启动无上次激活记录时的落点）。 */
  function setDefaultWorkspace(id: string | null): void {
    defaultWorkspaceId.value = id && workspaceById(id) ? id : null;
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
      lastUsedAt: now,
    };
    workspaces.value.push(workspace);
    activeWorkspaceId.value = workspace.id;
    persist();
    return workspace;
  }

  /**
   * 按**指定 id** 幂等建区（不存在才建），不触碰 `activeWorkspaceId`。
   *
   * 给「远程助手」这类系统工作区用：id 必须跨会话稳定，才能被别的模块按 id 找到
   * （`createWorkspace` 的 id 是生成的，找不回来）。
   *
   * 追加在末尾而不是插到队首：启动落点最后一档是 `workspaces[0]?.id`，插队首会让它
   * 在「用户只此一个工作区」时把启动页顶成系统工作区。
   */
  function ensureWorkspace(seed: { id: string; name: string; description?: string; icon?: string }): WorkspaceRecord {
    const existing = workspaceById(seed.id);
    if (existing) return existing;
    const now = Date.now();
    const workspace: WorkspaceRecord = {
      id: seed.id,
      name: seed.name.trim(),
      description: seed.description?.trim() ?? "",
      files: [],
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
      ...(seed.icon ? { icon: seed.icon } : {}),
    };
    workspaces.value.push(workspace);
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
    if (defaultWorkspaceId.value === id) defaultWorkspaceId.value = null;
    if (activeWorkspaceId.value === id) activeWorkspaceId.value = workspaces.value[0]?.id ?? null;
    persist();
  }

  /** 绑定用户选择的存放文件夹。会话文件搬迁由 lib/workspace-bind.ts 编排。 */
  function setFolder(id: string, folder: string): void {
    const workspace = workspaceById(id);
    if (!workspace) return;
    workspace.folder = folder;
    workspace.updatedAt = Date.now();
    persist();
  }

  /** 该工作区记住的 ACP / agent 配置（无记录返回 undefined，调用方据此决定「不动当前状态」）。 */
  function agentConfigOf(id: string | null): WorkspaceAgentConfig | undefined {
    return workspaceById(id)?.agentConfig;
  }

  /** 记忆 ACP / agent 配置：providerId 整体覆盖，configValues 逐键浅合并。 */
  function setAgentConfig(id: string, patch: WorkspaceAgentConfig): void {
    const workspace = workspaceById(id);
    if (!workspace) return;
    const previous = workspace.agentConfig ?? {};
    workspace.agentConfig = {
      providerId: "providerId" in patch ? patch.providerId : previous.providerId,
      configValues: patch.configValues ? { ...previous.configValues, ...patch.configValues } : previous.configValues,
    };
    persist();
  }

  /** 改工作区图标（传 null 回到兜底图标）；纯展示，不动 updatedAt（那代表内容变更）。 */
  function setWorkspaceIcon(id: string, icon: string | null): void {
    const workspace = workspaceById(id);
    if (!workspace) return;
    if (icon) workspace.icon = icon;
    else delete workspace.icon;
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
    defaultWorkspaceId,
    recentWorkspaces,
    workspaceById,
    workspaceByName,
    touchWorkspace,
    setActiveWorkspace,
    setDefaultWorkspace,
    createWorkspace,
    ensureWorkspace,
    renameWorkspace,
    updateDescription,
    deleteWorkspace,
    setFolder,
    setWorkspaceIcon,
    agentConfigOf,
    setAgentConfig,
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
