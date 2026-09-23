/**
 * Discord 通道的宿主通道（官方 Gateway 长连接 + REST 发消息）。
 *
 * 渲染端 CSP 不含外网域名，网关长连接与消息发送只能在 Rust 侧（`discord.rs`）；
 * 浏览器态没有宿主，调用方先看 `supported()` 再降级。
 *
 * 口径：只做**私聊**（官方文档明确私聊正文不受 `MESSAGE_CONTENT` 特权 intent 限制，
 * 所以只申请 `DIRECT_MESSAGES`）；bot token 只留在宿主（`<应用数据>/discord/`，0600）。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "@greywork/core";

import type { MediaRef } from "../types";

/** 宿主侧网关状态机。 */
export type DiscordState = "stopped" | "connecting" | "connected" | "error";

export interface DiscordStatus {
  /** 是否已保存 bot token。 */
  configured: boolean;
  /** 保存时探针取回的 bot 用户名（非秘密，便于确认填对了）。 */
  botUsername: string | null;
  state: DiscordState;
  detail: string | null;
  lastMessageAt: number | null;
  /** 已建档私聊数量。 */
  peerCount: number;
}

/** 入站消息：宿主已按「只放行归属人（或用户显式允许）」过滤。 */
export interface DiscordInbound {
  messageId: string;
  /** 对端 id：`dm:<channel_id>`。 */
  peerId: string;
  /** 发送者展示名（全局名 → 用户名 → 用户 id）。 */
  nick: string;
  /** 发送者用户 id。 */
  senderId: string;
  text: string;
  /** 随消息到达的附件（图片 / 文件）；字节在宿主 inbox，凭 `path` 取走。 */
  media?: MediaRef[];
  at: number;
}

export const DISCORD_STATE_EVENT = "discord://state";
export const DISCORD_INBOUND_EVENT = "discord://inbound";

export const discordBackend = {
  /** 仅桌面端可用；浏览器态调用方据此给出提示而非静默失败。 */
  supported: (): boolean => isTauriRuntime(),

  async status(): Promise<DiscordStatus> {
    return invoke<DiscordStatus>("discord_status");
  },

  /** 保存 bot token：宿主会先探针确认有效，无效直接报错、不落盘。 */
  async saveCredentials(token: string): Promise<DiscordStatus> {
    return invoke<DiscordStatus>("discord_save_credentials", { token });
  },

  /** 清除 token 与私聊档案（网关长连接随之停止）。 */
  async clearCredentials(): Promise<DiscordStatus> {
    return invoke<DiscordStatus>("discord_clear_credentials");
  },

  /** 启动网关长连接；`allowOtherSenders` = 除归属人外也答复其他人。 */
  async connect(allowOtherSenders: boolean): Promise<void> {
    await invoke("discord_connect", { allowOtherSenders });
  },

  async disconnect(): Promise<void> {
    await invoke("discord_disconnect");
  },

  /** 往已建档私聊回一条文本。 */
  async send(peerId: string, text: string): Promise<void> {
    await invoke("discord_send", { peerId, text });
  },

  async onState(listener: (status: DiscordStatus) => void): Promise<UnlistenFn> {
    return listen<DiscordStatus>(DISCORD_STATE_EVENT, (event) => listener(event.payload));
  },

  async onInbound(listener: (message: DiscordInbound) => void): Promise<UnlistenFn> {
    return listen<DiscordInbound>(DISCORD_INBOUND_EVENT, (event) => listener(event.payload));
  },
};
