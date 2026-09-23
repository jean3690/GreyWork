import { isAbsolutePath } from "@greywork/core";
import { useSessionStore } from "../stores/session";
import { useWorkspaceStore } from "../stores/workspace";
import { useChatStore } from "../stores/chat";

/**
 * 指定对话所属工作区的磁盘文件夹（桌面端绝对路径）。
 * 对话不存在 / 未绑定工作区 / 浏览器端 folder 仅为名称 → null。
 *
 * 按 threadId 取而不是只看「当前活动对话」：远程助手回一条消息时，活动对话是用户
 * 正在看的那个，而这一轮该在**对端会话**的工作区里跑（`agent/runtime.ts` 的 ACP cwd）。
 */
export function conversationFolder(threadId: string | null): string | null {
  if (!threadId) return null;
  const record = useSessionStore().getSession(threadId);
  const folder = record?.workspaceId ? useWorkspaceStore().workspaceById(record.workspaceId)?.folder : undefined;
  return folder && isAbsolutePath(folder) ? folder : null;
}

/**
 * 当前活动对话所属工作区的磁盘文件夹（桌面端绝对路径）。
 * 供 ACP 会话工作区锚定与产物默认落盘共用。
 */
export function activeConversationFolder(): string | null {
  return conversationFolder(useChatStore().activeThreadId);
}
