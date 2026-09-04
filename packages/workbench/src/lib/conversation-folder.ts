import { useSessionStore } from "../stores/session";
import { useWorkspaceStore } from "../stores/workspace";
import { useChatStore } from "../stores/chat";

/**
 * 当前活动对话所属工作区的磁盘文件夹（桌面端绝对路径）。
 * 未绑定工作区 / 会话不存在 / 浏览器端 folder 仅为名称 → null。
 * 供 ACP 会话工作区锚定与产物默认落盘共用。
 */
export function activeConversationFolder(): string | null {
  const threadId = useChatStore().activeThreadId;
  if (!threadId) return null;
  const record = useSessionStore().getSession(threadId);
  const folder = record?.workspaceId ? useWorkspaceStore().workspaceById(record.workspaceId)?.folder : undefined;
  return folder && /^[/\\]/.test(folder) ? folder : null;
}
