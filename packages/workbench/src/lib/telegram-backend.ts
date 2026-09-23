/**
 * Telegram 通道的宿主通道（Bot API 长轮询）。
 *
 * 渲染端 CSP 不含外网域名，长轮询与消息发送只能在 Rust 侧（`telegram.rs`）；
 * 浏览器态没有宿主，调用方先看 `supported()` 再降级。
 *
 * 凭证口径：bot token 只留在宿主（`<应用数据>/telegram/`，0600），
 * 渲染端只传对端 chat id / 文本，拿回状态与事件。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "@greywork/core";

import type { MediaRef } from "../types";

/** 宿主侧长轮询状态机。 */
export type TelegramState = "stopped" | "connecting" | "connected" | "error";

export interface TelegramStatus {
  /** 是否已保存 bot token。 */
  configured: boolean;
  state: TelegramState;
  detail: string | null;
  lastMessageAt: number | null;
  /** 已建档联系人数量。 */
  peerCount: number;
}

/** 入站消息：宿主已按「只放行归属人（或用户显式允许）」过滤。 */
export interface TelegramInbound {
  messageId: string;
  /** 对端 chat id（十进制字符串）。 */
  peerId: string;
  nick: string;
  /** 文本正文；非文本消息为空串（界面如实说明只认文字）。 */
  text: string;
  /** 随消息到达的图片 / 文件（语音、视频按文件收）；字节在宿主 inbox，凭 `path` 取走。 */
  media?: MediaRef[];
  at: number;
}

/** 扫码绑定用的机器人链接（宿主经 getMe 拼出）。 */
export interface TelegramBotLink {
  /** 机器人 @username（不含 `@`）。 */
  username: string;
  name: string;
  /** `https://t.me/<username>`：手机扫码即打开与机器人的对话。 */
  url: string;
}

export const TELEGRAM_STATE_EVENT = "telegram://state";
export const TELEGRAM_INBOUND_EVENT = "telegram://inbound";

export const telegramBackend = {
  /** 仅桌面端可用；浏览器态调用方据此给出提示而非静默失败。 */
  supported: (): boolean => isTauriRuntime(),

  async status(): Promise<TelegramStatus> {
    return invoke<TelegramStatus>("telegram_status");
  },

  /** 保存 bot token（宿主校验 `数字:密钥` 形状后才落盘）。 */
  async saveCredentials(token: string): Promise<TelegramStatus> {
    return invoke<TelegramStatus>("telegram_save_credentials", { token });
  },

  /** 清除 token 与联系人档案（长轮询随之停止）。 */
  async clearCredentials(): Promise<TelegramStatus> {
    return invoke<TelegramStatus>("telegram_clear_credentials");
  },

  /** 启动长轮询；`allowOtherSenders` = 除归属人外也答复其他联系人。 */
  async connect(allowOtherSenders: boolean): Promise<void> {
    await invoke("telegram_connect", { allowOtherSenders });
  },

  async disconnect(): Promise<void> {
    await invoke("telegram_disconnect");
  },

  /** 取机器人的 `t.me/<username>` 扫码链接（宿主调 getMe；未配置 token 时报错）。 */
  async botLink(): Promise<TelegramBotLink> {
    return invoke<TelegramBotLink>("telegram_bot_link");
  },

  /** 回一条文本（token 在宿主侧，这里只传对端 chat id 与文本）。 */
  async send(peerId: string, text: string): Promise<void> {
    await invoke("telegram_send", { peerId, text });
  },

  async onState(listener: (status: TelegramStatus) => void): Promise<UnlistenFn> {
    return listen<TelegramStatus>(TELEGRAM_STATE_EVENT, (event) => listener(event.payload));
  },

  async onInbound(listener: (message: TelegramInbound) => void): Promise<UnlistenFn> {
    return listen<TelegramInbound>(TELEGRAM_INBOUND_EVENT, (event) => listener(event.payload));
  },
};
