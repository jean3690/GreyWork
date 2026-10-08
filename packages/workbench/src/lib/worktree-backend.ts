/**
 * 隔离快照双态后端：设置页「运行模式」的回收面板消费。
 * - 桌面态：Rust `worktree_list` / `worktree_release`（宿主侧才是快照的账本）。
 * - 浏览器态：没有宿主，列表恒空、释放直接抛错 —— 不静默假装成功。
 */

import { hasHostCommands, invoke } from "@greywork/host-ipc";
import type { WorktreeProvision } from "./workspace-dir";

/** `worktree_list` 的一行，与 provision 返回的 kind 同域（同一套宿主契约）。 */
export interface WorktreeEntry {
  root: string;
  /** git = 真实 worktree / copy = 目录复制兜底 / direct = 数据根直通（直通不落快照，故不会出现在列表里）。 */
  kind: WorktreeProvision["kind"];
  source: string;
  /**
   * 快照目录占用字节。git 快照只统计检出的文件：对象库与源仓库共享，
   * 仓库历史不计在内，所以这个数比「克隆一份」小得多。
   */
  bytes: number;
}

export const worktreeBackend = {
  active(): boolean {
    return hasHostCommands();
  },

  /** 列出已派生的隔离快照；浏览器态返回空列表。 */
  async list(): Promise<WorktreeEntry[]> {
    if (!hasHostCommands()) return [];
    return await invoke<WorktreeEntry[]>("worktree_list");
  },

  /** 释放（删除）一个快照目录。宿主侧只接受 `~/.greyWork/worktrees` 之下的路径。 */
  async release(root: string): Promise<void> {
    if (!hasHostCommands()) throw new Error("浏览器预览态无法释放隔离快照：需要桌面版（Tauri）");
    await invoke("worktree_release", { root });
  },

  /**
   * 记一次工作区回合快照，返回其 ref（`refs/greywork/snap/<id>`）。
   * 只对 git 隔离快照（kind=git）有效；其余情况宿主直接报错，调用方按「无快照」处理。
   */
  async snapshot(root: string): Promise<string> {
    if (!hasHostCommands()) throw new Error("浏览器预览态无法做工作区快照：需要桌面版（Tauri）");
    return await invoke<string>("worktree_snapshot", { root });
  },

  /** 把工作区硬回退到某个快照 ref（严格等于快照：快照之后新建的文件会被删除）。 */
  async restore(root: string, reference: string): Promise<void> {
    if (!hasHostCommands()) throw new Error("浏览器预览态无法回退工作区：需要桌面版（Tauri）");
    await invoke("worktree_restore", { root, reference });
  },
};
