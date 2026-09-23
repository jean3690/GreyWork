/**
 * 联系人档案切片：联系人列表的增删改查、未读游标、联系人 → 工作区会话的桥接，
 * 以及往会话里落消息的小工具（远端管线与桌面手发共用）。
 */
import { computed, type ComputedRef } from "vue";
import type { Attachment, ThreadMessage } from "../../types";
import { ensureRemoteWorkspace } from "../../lib/remote-workspace";
import { peerKey, t, wid, writePeerArchive, type RemoteChannel, type RemotePeer } from "./shared";
import type { RemoteAssistantState } from "./state";

export interface PeersApi {
  persistPeers(): void;
  peerByKey(key: string): RemotePeer | undefined;
  /** 联系人列表（最近有往来在前）。 */
  peerList: ComputedRef<RemotePeer[]>;
  markPeerRead(key: string): void;
  peerSessionId(peer: RemotePeer): string;
  /** 作废某通道全部联系人的会话绑定（退出登录 / 清凭证后调用）。 */
  resetChannelSessions(channel: RemoteChannel): void;
  appendRemoteMessage(sessionId: string, role: "user" | "assistant", content: string, attachments?: readonly Attachment[]): ThreadMessage;
  /** 改写会话里某条消息的正文（ACP 支架就地收尾；找不到即忽略，不落盘）。 */
  updateRemoteMessage(sessionId: string, messageId: string, content: string): void;
  readMessageContent(sessionId: string, messageId: string): string;
}

export function createPeersSlice({ state }: { state: RemoteAssistantState }): PeersApi {
  const sessionStore = state.session;

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
   * 远程会话的落点：「远程助手」工作区；还没建就现建一个（同步兜底）。
   *
   * 走到兜底说明 `init` 那次没建成（当时一条通道都还没配置）或工作区被用户删了 ——
   * 会话必须有个归属，不能因此回落到用户当前打开的工作区。
   */
  function targetWorkspaceId(): string {
    return ensureRemoteWorkspace(state.workspace).id;
  }

  /**
   * 联系人 → 会话：已有会话沿用；没有则新建并把激活位还原
   * （收消息不该把用户正在看的会话切走）。
   */
  function peerSessionId(peer: RemotePeer): string {
    const existing = peerByKey(peerKey(peer));
    if (existing && existing.sessionId && sessionStore.getSession(existing.sessionId)) return existing.sessionId;

    const previousActive = sessionStore.activeSessionId;
    const channelName = t(`remoteAssist.channels.${peer.channel}`);
    const session = sessionStore.createSession(targetWorkspaceId(), `${channelName} · ${peer.nick}`);
    sessionStore.setActive(previousActive);
    if (existing) existing.sessionId = session.id;
    else state.peers.value = [...state.peers.value, { ...peer, sessionId: session.id }];
    persistPeers();
    return session.id;
  }

  /**
   * 作废某通道全部联系人的会话绑定（退出登录 / 清凭证后调用）。
   *
   * 下一次来消息时 `peerSessionId` 会另开一条新会话 —— 重新建立连接不该沿用上一段
   * 连接的上下文，模型那边也就能从干净状态开始。
   *
   * 回发凭据一并清：`contextToken` 属于上一段连接，留着只会让桌面手发拿一个已失效的
   * 凭据去撞服务端，还会绕过微信通道「对方还没发过消息」那条更准确的提示。
   */
  function resetChannelSessions(channel: RemoteChannel): void {
    let changed = false;
    for (const peer of state.peers.value) {
      if (peer.channel !== channel) continue;
      if (peer.sessionId === "" && peer.contextToken === null) continue;
      peer.sessionId = "";
      peer.contextToken = null;
      changed = true;
    }
    if (changed) persistPeers();
  }

  /**
   * 往联系人会话里落一条消息（远端管线与桌面手发共用）。
   *
   * `attachments` 已由调用方落库（只有 path，没有内联数据），这里只做搬运 ——
   * 会话是整条 ThreadMessage 落盘的，内联数据不能出现在这条路径上。
   */
  function appendRemoteMessage(
    sessionId: string,
    role: "user" | "assistant",
    content: string,
    attachments: readonly Attachment[] = [],
  ): ThreadMessage {
    const message: ThreadMessage = {
      id: wid(),
      role,
      content,
      ts: Date.now(),
      ...(attachments.length ? { attachments: [...attachments] } : {}),
    };
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
    resetChannelSessions,
    appendRemoteMessage,
    updateRemoteMessage,
    readMessageContent,
  };
}
