/**
 * QQ 通道的宿主通道（QQ 开放平台机器人，官方 WebSocket 网关）。
 *
 * 渲染端 CSP 不含外网域名，网关长连接与消息发送只能在 Rust 侧（`qq.rs`）；
 * 浏览器态没有宿主，调用方先看 `supported()` 再降级。
 *
 * 凭证口径：AppSecret 与 access_token 都只留在宿主（`<应用数据>/qq/`，0600）；
 * 回发凭据（入站消息的 msg_id）同样留在宿主——QQ 要求被动回复带回它，5 分钟有效。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "@greywork/core";

/** 宿主侧网关状态机。 */
export type QqState = "stopped" | "connecting" | "connected" | "error";

export interface QqStatus {
  /** 是否已保存 AppID + AppSecret。 */
  configured: boolean;
  /** 非秘密的 AppID（展示出来便于确认填对了）。 */
  appId: string | null;
  state: QqState;
  detail: string | null;
  lastMessageAt: number | null;
  /** 已建档联系人数量。 */
  peerCount: number;
}

/** 入站消息：宿主已按「只放行归属人（或用户显式允许）」过滤。 */
export interface QqInbound {
  /** 消息 id（被动回复带上它回；宿主也留了一份）。 */
  messageId: string;
  /** 对端 id：`c2c:<openid>`（单聊）/ `group:<openid>`（群聊）。 */
  peerId: string;
  nick: string;
  /** 发送者 openid（群聊里用来判归属人）。 */
  senderId: string;
  text: string;
  at: number;
}

export const QQ_STATE_EVENT = "qq://state";
export const QQ_INBOUND_EVENT = "qq://inbound";

export const qqBackend = {
  /** 仅桌面端可用；浏览器态调用方据此给出提示而非静默失败。 */
  supported: (): boolean => isTauriRuntime(),

  async status(): Promise<QqStatus> {
    return invoke<QqStatus>("qq_status");
  },

  /** 保存凭证；`appSecret` 传空串表示只改 AppID（沿用已存密钥）。 */
  async saveCredentials(appId: string, appSecret: string): Promise<QqStatus> {
    return invoke<QqStatus>("qq_save_credentials", {
      appId,
      appSecret: appSecret.trim() ? appSecret : null,
    });
  },

  /** 清除凭证与联系人凭据（网关长连接随之停止）。 */
  async clearCredentials(): Promise<QqStatus> {
    return invoke<QqStatus>("qq_clear_credentials");
  },

  /** 启动网关长连接；`allowOtherSenders` = 除归属人外也答复其他人。 */
  async connect(allowOtherSenders: boolean): Promise<void> {
    await invoke("qq_connect", { allowOtherSenders });
  },

  async disconnect(): Promise<void> {
    await invoke("qq_disconnect");
  },

  /** 回一条文本（被动回复凭据在宿主侧，这里只传对端与文本）。 */
  async send(peerId: string, text: string): Promise<void> {
    await invoke("qq_send", { peerId, text });
  },

  async onState(listener: (status: QqStatus) => void): Promise<UnlistenFn> {
    return listen<QqStatus>(QQ_STATE_EVENT, (event) => listener(event.payload));
  },

  async onInbound(listener: (message: QqInbound) => void): Promise<UnlistenFn> {
    return listen<QqInbound>(QQ_INBOUND_EVENT, (event) => listener(event.payload));
  },
};
