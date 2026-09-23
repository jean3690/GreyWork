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
import type { CommitResult, GitChange, GitCommit, GitStatusEntry, HistoryGitService } from "./types";

/** 可注入的 IPC 调用形态（收窄自 Tauri invoke，测试好替换）。 */
export type IpclessInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** 磁盘态 Git 服务：命令名即宿主命令，root 回填为第一个参数。 */
export function createTauriGitService(root: string, invokeImpl: IpclessInvoke = tauriInvoke): HistoryGitService {
  const call = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => invokeImpl(command, { root, ...args }) as Promise<T>;
  return {
    async status(): Promise<GitStatusEntry[]> {
      return call<GitStatusEntry[]>("git_status");
    },
    async changes(): Promise<GitChange[]> {
      return call<GitChange[]>("git_changes");
    },
    async diff(path?: string, staged = false): Promise<string> {
      // 没有 path 时不带 path 键（宿主那边是 Option，多余的 null 会被当成字符串）。
      return call<string>("git_diff", path === undefined ? { staged } : { path, staged });
    },
    async stage(paths: string[]): Promise<void> {
      await call("git_stage", { paths, all: false });
    },
    async stageAll(): Promise<void> {
      await call("git_stage", { paths: [], all: true });
    },
    async unstage(paths: string[]): Promise<void> {
      await call("git_unstage", { paths, all: false });
    },
    async unstageAll(): Promise<void> {
      await call("git_unstage", { paths: [], all: true });
    },
    async commit(message: string, options?: { all?: boolean }): Promise<CommitResult> {
      return call<CommitResult>("git_commit", { message, all: options?.all ?? false });
    },
    async currentBranch(): Promise<string> {
      return (await call<string>("git_current_branch")).trim();
    },
    async branches(): Promise<string[]> {
      return call<string[]>("git_branch_list");
    },
    async log(options?: { limit?: number; skip?: number }): Promise<GitCommit[]> {
      // 没传的键不带过去（宿主是 Option，多余的 null 在 Tauri 侧会变成解析失败的参数）。
      const args: Record<string, unknown> = {};
      if (options?.limit !== undefined) args.limit = options.limit;
      if (options?.skip !== undefined) args.skip = options.skip;
      return call<GitCommit[]>("git_log", args);
    },
    async show(hash: string, path?: string): Promise<string> {
      return call<string>("git_show", path === undefined ? { hash } : { hash, path });
    },
  };
}
