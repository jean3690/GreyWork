/**
 * 绑定工作区文件夹的唯一入口。
 *
 * 「记住新文件夹」和「把既有会话搬到新文件夹」必须成对发生：只做前者的话，已绑旧
 * 目录的会话会留在原处，只有新会话按新目录落盘 —— 用户看到的就是「换了文件夹，历史
 * 对话没跟过来」。编排放在 lib 而不是 store 里，因为 workspace store 不能反向依赖
 * session store（session store 已经依赖 workspace store，会成环）。
 */

import { relocateWorkspaceSessions, type RelocateResult } from "./session-relocate";
import { useWorkspaceStore } from "../stores/workspace";

const NOTHING_MOVED: RelocateResult = { moved: 0, missing: [], conflicts: [] };

export async function bindWorkspaceFolder(workspaceId: string, folder: string): Promise<RelocateResult> {
  const workspaceStore = useWorkspaceStore();
  const previous = workspaceStore.workspaceById(workspaceId)?.folder;
  if (previous === folder) return NOTHING_MOVED;
  workspaceStore.setFolder(workspaceId, folder);
  try {
    return await relocateWorkspaceSessions(workspaceId, previous, folder);
  } catch (error) {
    // 绑定是用户的明确意图，不因搬迁失败回滚：宁可会话暂留旧目录（下次同步会按新归属
    // 重新写出），也不要把用户刚选的文件夹悄悄丢掉。
    console.error("[workspace] 会话搬迁失败，文件夹绑定保留", error);
    return NOTHING_MOVED;
  }
}
