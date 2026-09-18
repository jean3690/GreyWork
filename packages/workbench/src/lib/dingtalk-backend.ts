/**
 * 钉钉通道的宿主通道（Stream 模式）。
 *
 * 渲染端 CSP 不含外网域名，长连接与消息发送只能在 Rust 侧（`dingtalk.rs`）；
 * 浏览器态没有宿主，调用方先看 `supported()` 再降级。
 *
 * 凭证口径：AppSecret 与「回消息用的 sessionWebhook」都只留在宿主
 * （`<应用数据>/dingtalk/`，0600），渲染端只传 clientId / 文本，拿回状态与事件。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "@greywork/core";

/** 宿主侧长连接状态机。 */
export type DingTalkState = "stopped" | "connecting" | "connected" | "error";

export interface DingTalkStatus {
  /** 是否已保存应用凭证（clientId + clientSecret）。 */
  configured: boolean;
  /** 凭证里的 clientId（AppKey 不是秘密，展示出来便于确认填对了）。 */
  clientId: string | null;
  state: DingTalkState;
  detail: string | null;
  lastMessageAt: number | null;
  /** 已建档联系人数量。 */
  peerCount: number;
}

/** 入站消息：宿主已按「只放行归属人（或用户显式允许）」过滤。 */
export interface DingTalkInbound {
  msgId: string | null;
  /** 员工 id（单聊）或会话 id（群聊兜底）。 */
  peerId: string;
  /** 发送者昵称。 */
  nick: string;
  text: string;
  /** 消息类型：text / picture / audio …（非文本由界面如实说明）。 */
  msgType: string | null;
  conversationType: string | null;
  at: number;
}

export const DINGTALK_STATE_EVENT = "dingtalk://state";
export const DINGTALK_INBOUND_EVENT = "dingtalk://inbound";

/** 扫码创建应用的引导信息（`device_code` 只在宿主，不下发到界面）。 */
export interface DingTalkRegisterStart {
  /** 编成二维码的链接（手机钉钉扫它）。 */
  qrUrl: string;
  /** 手机上的配对码（钉钉不保证下发，可能为 null）。 */
  userCode: string | null;
  expiresIn: number;
  /** 服务端要求的轮询间隔（秒）。 */
  interval: number;
}

/** 一次轮询的结果；`done` 时凭证已由宿主落盘（界面只拿到 Client ID）。 */
export interface DingTalkRegisterPoll {
  state: "pending" | "done" | "expired" | "error";
  detail: string | null;
  clientId: string | null;
}

export const dingtalkBackend = {
  /** 仅桌面端可用；浏览器态调用方据此给出提示而非静默失败。 */
  supported: (): boolean => isTauriRuntime(),

  async status(): Promise<DingTalkStatus> {
    return invoke<DingTalkStatus>("dingtalk_status");
  },

  /** 保存凭证；`clientSecret` 传空串表示只改 clientId（沿用已存密钥）。 */
  async saveCredentials(clientId: string, clientSecret: string): Promise<DingTalkStatus> {
    return invoke<DingTalkStatus>("dingtalk_save_credentials", {
      clientId,
      clientSecret: clientSecret.trim() ? clientSecret : null,
    });
  },

  /** 清除凭证与联系人回发凭据（长连接随之停止）。 */
  async clearCredentials(): Promise<DingTalkStatus> {
    return invoke<DingTalkStatus>("dingtalk_clear_credentials");
  },

  /** 启动 Stream 长连接；`allowOtherSenders` = 除归属人外也答复其他同事。 */
  async connect(allowOtherSenders: boolean): Promise<void> {
    await invoke("dingtalk_connect", { allowOtherSenders });
  },

  async disconnect(): Promise<void> {
    await invoke("dingtalk_disconnect");
  },

  /** 回一条文本（回发凭据在宿主侧，这里只传对端与文本）。 */
  async send(peerId: string, text: string): Promise<void> {
    await invoke("dingtalk_send", { peerId, text });
  },

  /** 发起扫码创建应用（不必先去控制台手工建应用）。 */
  async registerBegin(): Promise<DingTalkRegisterStart> {
    return invoke<DingTalkRegisterStart>("dingtalk_register_begin");
  },

  /** 轮询扫码结果；成功那一轮宿主会把 Client ID / Client Secret 写好。 */
  async registerPoll(): Promise<DingTalkRegisterPoll> {
    return invoke<DingTalkRegisterPoll>("dingtalk_register_poll");
  },

  /** 放弃本次扫码（作废 device_code）。 */
  async registerCancel(): Promise<void> {
    await invoke("dingtalk_register_cancel");
  },

  async onState(listener: (status: DingTalkStatus) => void): Promise<UnlistenFn> {
    return listen<DingTalkStatus>(DINGTALK_STATE_EVENT, (event) => listener(event.payload));
  },

  async onInbound(listener: (message: DingTalkInbound) => void): Promise<UnlistenFn> {
    return listen<DingTalkInbound>(DINGTALK_INBOUND_EVENT, (event) => listener(event.payload));
  },
};
