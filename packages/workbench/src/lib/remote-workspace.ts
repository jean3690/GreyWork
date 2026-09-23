/**
 * 「远程助手」工作区：远程通道的联系人会话统一归它管，并绑一个真实磁盘文件夹。
 *
 * 为什么是固定 id：这个工作区不是用户建的，得能被别的模块按 id 稳定找到
 * （`createWorkspace` 的 id 是生成的，找不回来），所以走 `ensureWorkspace` 的指定 id 建区。
 * 固定 id 比在 `WorkspaceRecord` 上加 `kind` 字段少一层持久化校验面，也比把 id 存进
 * `RemoteAssistPrefs` 少一处间接。
 *
 * 这里刻意不内部 `useWorkspaceStore()`：调用方（远程切片）拿到的是注入进来的 store，
 * 单测注入假实现即可，不必为每个用例起一个真 Pinia。
 */
import { isTauriRuntime, joinPath } from "@greywork/core";
import { i18n } from "../i18n";
import { ensureDir } from "../state/workspaceFiles";
import { resolveWorkspaceDir } from "./workspace-dir";
import type { WorkspaceRecord } from "../stores/workspace";

const t = i18n.global.t;

/** 「远程助手」工作区的固定 id（`makeId()` 产出 `w-<base36>-<seq>`，不会撞）。 */
export const REMOTE_WORKSPACE_ID = "w-remote";
/** 默认文件夹名：`<工作区根>/remote`。 */
export const REMOTE_WORKSPACE_FOLDER = "remote";

/** 本模块用到的工作区 store 面（结构化类型，便于单测注入假实现）。 */
export interface RemoteWorkspaceStore {
  workspaceById(id: string | null): WorkspaceRecord | undefined;
  ensureWorkspace(seed: { id: string; name: string; description?: string; icon?: string }): WorkspaceRecord;
  setFolder(id: string, folder: string): void;
}

/** 幂等建「远程助手」工作区（固定 id、robot 图标）；不切换用户当前工作区。 */
export function ensureRemoteWorkspace(store: RemoteWorkspaceStore): WorkspaceRecord {
  return (
    store.workspaceById(REMOTE_WORKSPACE_ID) ??
    store.ensureWorkspace({ id: REMOTE_WORKSPACE_ID, name: t("remoteAssist.workspace.name"), icon: "robot" })
  );
}

/** 默认文件夹：`resolveWorkspaceDir()` 未设 `workspaceDir` 时即 `~/.greyWork/remote`。 */
export function defaultRemoteWorkspaceFolder(): Promise<string> {
  return resolveWorkspaceDir().then((root) => joinPath(root, REMOTE_WORKSPACE_FOLDER));
}

/**
 * 首次给「远程助手」工作区绑上默认文件夹；已绑则原样返回，浏览器态返回 null。
 *
 * 刻意走 `setFolder` 而不是 `bindWorkspaceFolder`：默认绑定发生在启动期，此刻这个
 * 工作区里必然还没有会话，搬迁是空跑 —— 却要额外和 `sessionBackend` 水合抢一次时序。
 * **用户主动换绑**（设置页弹窗）才走 `bindWorkspaceFolder`，那里搬迁是真需要的。
 */
export async function ensureRemoteWorkspaceFolder(store: RemoteWorkspaceStore): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const workspace = ensureRemoteWorkspace(store);
  if (workspace.folder) return workspace.folder;
  const folder = await defaultRemoteWorkspaceFolder();
  await ensureDir(folder);
  store.setFolder(workspace.id, folder);
  return folder;
}
