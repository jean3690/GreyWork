/**
 * 联系人档案切片：联系人列表的增删改查、未读游标、联系人 → 工作区会话的桥接，
 * 以及往会话里落消息的小工具（远端管线与桌面手发共用）。
 */
import { computed, type ComputedRef } from "vue";
import type { ThreadMessage } from "../../types";
import { peerKey, t, wid, writePeerArchive, type RemotePeer } from "./shared";
import type { RemoteAssistantState } from "./state";

export interface PeersApi {
  persistPeers(): void;
  peerByKey(key: string): RemotePeer | undefined;
  /** 联系人列表（最近有往来在前）。 */
  peerList: ComputedRef<RemotePeer[]>;
  markPeerRead(key: string): void;
  peerSessionId(peer: RemotePeer): string;
  appendRemoteMessage(sessionId: string, role: "user" | "assistant", content: string): ThreadMessage;
  /** 改写会话里某条消息的正文（ACP 支架就地收尾；找不到即忽略，不落盘）。 */
  updateRemoteMessage(sessionId: string, messageId: string, content: string): void;
  readMessageContent(sessionId: string, messageId: string): string;
}

export function createPeersSlice({ state }: { state: RemoteAssistantState }): PeersApi {
  const sessionStore = state.session;
  const workspaceStore = state.workspace;

  function persistPeers(): void {
    writePeerArchive(state.peers.value);
  }

  function peerByKey(key: string): RemotePeer | undefined {
    return state.peers.value.find((peer) => peerKey(peer) === key);
  }

  /** 联系人列表（最近有往来在前）。 */
  const peerList = computed(() => [...state.peers.value].sort((left, right) => right.lastAt - left.lastAt));

  /** 标记读到最新（会话页挂载 / 新消息到达且正在看时调用）。 */
  function markPeerRead(key: string): void {
    const peer = peerByKey(key);
    if (!peer || peer.readAt >= peer.lastAt) return;
    peer.readAt = peer.lastAt;
    persistPeers();
  }

  /**
   * 联系人 → 会话：已有会话沿用；没有则新建并把激活位还原
   * （收消息不该把用户正在看的会话切走）。
   */
  function peerSessionId(peer: RemotePeer): string {
    const existing = peerByKey(peerKey(peer));
    if (existing && sessionStore.getSession(existing.sessionId)) return existing.sessionId;

    const previousActive = sessionStore.activeSessionId;
    const channelName = t(`remoteAssist.channels.${peer.channel}`);
    const session = sessionStore.createSession(workspaceStore.activeWorkspaceId, `${channelName} · ${peer.nick}`);
    sessionStore.setActive(previousActive);
    if (existing) existing.sessionId = session.id;
    else state.peers.value = [...state.peers.value, { ...peer, sessionId: session.id }];
    persistPeers();
    return session.id;
  }

  function appendRemoteMessage(sessionId: string, role: "user" | "assistant", content: string): ThreadMessage {
    const message: ThreadMessage = { id: wid(), role, content, ts: Date.now() };
    sessionStore.appendMessage(sessionId, message);
    return message;
  }

  function updateRemoteMessage(sessionId: string, messageId: string, content: string): void {
    const message = sessionStore.getSession(sessionId)?.messages.find((candidate) => candidate.id === messageId);
    if (!message) return;
    message.content = content;
    sessionStore.markDirty();
  }

  function readMessageContent(sessionId: string, messageId: string): string {
    const messages = sessionStore.getSession(sessionId)?.messages ?? [];
    return messages.find((message) => message.id === messageId)?.content ?? "";
  }

  return {
    persistPeers,
    peerByKey,
    peerList,
    markPeerRead,
    peerSessionId,
    appendRemoteMessage,
    updateRemoteMessage,
    readMessageContent,
  };
}
