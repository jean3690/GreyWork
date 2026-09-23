/**
 * 企业微信通道的宿主通道（智能机器人「API 模式 · 长连接」）。
 *
 * 渲染端 CSP 不含外网域名，长连接与回复都只能在 Rust 侧（`wecom.rs`）；
 * 浏览器态没有宿主，调用方先看 `supported()` 再降级。
 *
 * 凭证口径：智能机器人的 Secret 只留在宿主（`<应用数据>/wecom/`，0600）；
 * 被动回复凭据（回调的 req_id）同样留在宿主，渲染端只传文本与对端 id。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "@greywork/core";

import type { MediaRef } from "../types";

/** 宿主侧长连接状态机。 */
export type WecomState = "stopped" | "connecting" | "connected" | "error";

export interface WecomStatus {
  /** 是否已保存 BotID + Secret。 */
  configured: boolean;
  /** 非秘密的 BotID（展示出来便于确认填对了）。 */
  botId: string | null;
  state: WecomState;
  detail: string | null;
  lastMessageAt: number | null;
  /** 已建档联系人数量。 */
  peerCount: number;
}

/** 入站消息：宿主已按「只放行归属人（或用户显式允许）」过滤。 */
export interface WecomInbound {
  msgId: string;
  /** 对端 id：`single:<userid>`（单聊）/ `group:<chatid>`（群聊）。 */
  peerId: string;
  nick: string;
  /** 发送者 userid（判归属人）。 */
  senderId: string;
  text: string;
  /** 收不下也转不成文本的消息类型（如 voice）；文本 / 图片 / 文件为空串。 */
  unsupported: string;
  /** 随消息到达的图片 / 文件（长连接媒体已按 aeskey 解密）；字节在宿主 inbox，凭 `path` 取走。 */
  media?: MediaRef[];
  at: number;
}

export const WECOM_STATE_EVENT = "wecom://state";
export const WECOM_INBOUND_EVENT = "wecom://inbound";

export const wecomBackend = {
  /** 仅桌面端可用；浏览器态调用方据此给出提示而非静默失败。 */
  supported: (): boolean => isTauriRuntime(),

  async status(): Promise<WecomStatus> {
    return invoke<WecomStatus>("wecom_status");
  },

  /** 保存凭证；`secret` 传空串表示只改 BotID（沿用已存密钥）。 */
  async saveCredentials(botId: string, secret: string): Promise<WecomStatus> {
    return invoke<WecomStatus>("wecom_save_credentials", {
      botId,
      secret: secret.trim() ? secret : null,
    });
  },

  /** 清除凭证与联系人凭据（长连接随之停止）。 */
  async clearCredentials(): Promise<WecomStatus> {
    return invoke<WecomStatus>("wecom_clear_credentials");
  },

  /** 启动长连接；`allowOtherSenders` = 除归属人外也答复其他人。 */
  async connect(allowOtherSenders: boolean): Promise<void> {
    await invoke("wecom_connect", { allowOtherSenders });
  },

  async disconnect(): Promise<void> {
    await invoke("wecom_disconnect");
  },

  /** 回一条文本（回调凭据在宿主侧，这里只传对端与文本）。 */
  async send(peerId: string, text: string): Promise<void> {
    await invoke("wecom_send", { peerId, text });
  },

  async onState(listener: (status: WecomStatus) => void): Promise<UnlistenFn> {
    return listen<WecomStatus>(WECOM_STATE_EVENT, (event) => listener(event.payload));
  },

  async onInbound(listener: (message: WecomInbound) => void): Promise<UnlistenFn> {
    return listen<WecomInbound>(WECOM_INBOUND_EVENT, (event) => listener(event.payload));
  },
};
