/**
 * Tauri 桌面端的真实文件系统 / Git 适配器。
 *
 * 内存实现（memory.ts）是纯假数据，给不了「真实工作区」语义：ACP agent（Codex /
 * Claude Code）是直接往磁盘写文件的。这里经宿主 `workspace_fs` / `git` 命令把
 * `WorkspaceFileSystem` / `GitService` 接口接到真实磁盘，命令名与参数形态见
 * `apps/desktop/src-tauri/src/` 对应模块。
 *
 * 可测性：`invoke` 由调用方注入（Vitest 里喂假实现），默认指向 Tauri IPC。域名层不
 * 感知宿主细节，测试不碰 Tauri。
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { CommitResult, GitChange, GitService, GitStatusEntry } from "./types";

/** 可注入的 IPC 调用形态（收窄自 Tauri invoke，测试好替换）。 */
export type IpclessInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** 磁盘态 Git 服务：命令名即宿主命令，root 回填为第一个参数。 */
export function createTauriGitService(root: string, invokeImpl: IpclessInvoke = tauriInvoke): GitService {
  const call = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => invokeImpl(command, { root, ...args }) as Promise<T>;
  return {
    async status(): Promise<GitStatusEntry[]> {
      return call<GitStatusEntry[]>("git_status");
    },
    async changes(): Promise<GitChange[]> {
      return call<GitChange[]>("git_changes");
    },
    async diff(path?: string): Promise<string> {
      return call<string>("git_diff", path === undefined ? {} : { path });
    },
    async commit(message: string): Promise<CommitResult> {
      return call<CommitResult>("git_commit", { message });
    },
    async currentBranch(): Promise<string> {
      return (await call<string>("git_current_branch")).trim();
    },
    async branches(): Promise<string[]> {
      return call<string[]>("git_branch_list");
    },
  };
}
