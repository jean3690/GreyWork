/**
 * 隔离工作树（runMode=worktree）的回收面：`worktree_list` / `worktree_release`。
 *
 * 快照落在 `~/.greyWork/worktrees/<slug>-<hash>`，每个目录带 `.greywork-worktree.json`
 * 标记（kind=git|copy + 源路径）。列表**只认写过标记的目录**；回收只允许删基目录之下的条目，
 * 且 git 快照优先交给 `git worktree remove`（对象库与源仓库共享，直接删目录会留下登记）。
 *
 * provision / snapshot / restore 尚未迁移（需要 ACP 工作区绑定与回合快照 ref），
 * `/api/commands` 里标为未迁移、调用回 501。
 */
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import type { WorkspaceAccess } from "./workspace-access.js";

const WORKTREES_SUB_DIR = "worktrees";
const MARKER_FILE = ".greywork-worktree.json";

export interface WorktreeEntry {
  root: string;
  kind: string;
  source: string;
  bytes: number;
}

interface Marker {
  kind: string;
  source: string;
}

function readMarker(target: string): Marker | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(target, MARKER_FILE), "utf8")) as Partial<Marker>;
    if (typeof parsed.kind !== "string" || typeof parsed.source !== "string") return null;
    return { kind: parsed.kind, source: parsed.source };
  } catch {
    return null;
  }
}

/** 目录占用字节（递归累加普通文件；链接不跟随，避免环与越界）。 */
function dirBytes(target: string): number {
  let total = 0;
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  for (const name of readdirSync(target)) total += dirBytes(path.join(target, name));
  return total;
}

export function listWorktrees(access: WorkspaceAccess): WorktreeEntry[] {
  const base = path.join(access.root, WORKTREES_SUB_DIR);
  if (!existsSync(base)) return [];
  const found: WorktreeEntry[] = [];
  for (const name of readdirSync(base)) {
    const target = path.join(base, name);
    if (!statSync(target).isDirectory()) continue;
    const marker = readMarker(target);
    if (!marker) continue;
    found.push({ root: target, kind: marker.kind, source: marker.source, bytes: dirBytes(target) });
  }
  return found.sort((left, right) => left.root.localeCompare(right.root));
}

export async function releaseWorktree(
  access: WorkspaceAccess,
  rootRaw: string,
  runGit: (repo: string, args: string[]) => Promise<string>,
): Promise<void> {
  const root = access.resolveExisting(rootRaw);
  const base = path.join(access.root, WORKTREES_SUB_DIR);
  const relative = path.relative(base, root);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("只允许释放 ~/.greyWork/worktrees 下的隔离快照");
  }
  if (!existsSync(root)) return; // 幂等：已回收视为成功
  const marker = readMarker(root);
  if (marker?.kind === "git" && existsSync(marker.source)) {
    try {
      // 必须在源仓库内执行：git 不允许移除「当前工作树」。
      await runGit(marker.source, ["worktree", "remove", "--force", "--force", root]);
    } catch {
      // 退回整目录删除（快照本就是可丢弃的）。
    }
  }
  if (!existsSync(root)) return;
  try {
    rmSync(root, { recursive: true });
  } catch (error) {
    throw new Error(`删除快照目录失败: ${(error as Error).message}`, { cause: error });
  }
}
