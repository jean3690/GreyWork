/**
 * 飞书通道的宿主通道（自建应用 + 长连接）。
 *
 * 与钉钉同构：渲染端 CSP 不含外网域名，长连接与发消息只能在 Rust 侧（`feishu.rs`）；
 * 浏览器态没有宿主，调用方先看 `supported()` 再降级。
 *
 * 凭证口径：AppSecret 与 tenant_access_token 都只留在宿主（`<应用数据>/feishu/`，0600），
 * 渲染端只传 AppID / AppSecret 一次与「文本」，其余走状态与事件。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "@greywork/core";

export type FeishuState = "stopped" | "connecting" | "connected" | "error";

export interface FeishuStatus {
  /** 是否已保存应用凭证（AppID + AppSecret）。 */
  configured: boolean;
  appId: string | null;
  state: FeishuState;
  detail: string | null;
  lastMessageAt: number | null;
  peerCount: number;
}

/** 入站消息：宿主已按「只放行归属人（或用户显式允许）」过滤。 */
export interface FeishuInbound {
  messageId: string | null;
  /** 单聊 = 发送者 open_id；群聊 = chat_id。 */
  peerId: string;
  nick: string;
  text: string;
  /** text / image / audio …（非文本由界面如实说明）。 */
  messageType: string | null;
  /** p2p / group。 */
  chatType: string | null;
  at: number;
}

export const FEISHU_STATE_EVENT = "feishu://state";
export const FEISHU_INBOUND_EVENT = "feishu://inbound";

/** 扫码创建应用的引导信息（`device_code` 只在宿主，不下发到界面）。 */
export interface FeishuRegisterStart {
  /** 编成二维码的链接（手机飞书扫它）。 */
  qrUrl: string;
  /** 手机上的配对码，便于确认扫的是哪一次。 */
  userCode: string;
  expiresIn: number;
  /** 服务端要求的轮询间隔（秒）。 */
  interval: number;
}

/** 一次轮询的结果；`done` 时凭证已由宿主落盘（界面只拿到 AppID）。 */
export interface FeishuRegisterPoll {
  state: "pending" | "done" | "denied" | "expired" | "error";
  detail: string | null;
  appId: string | null;
  /** 服务端要求的轮询间隔（毫秒）；`slow_down` 后会变大。 */
  intervalMs: number | null;
}

export const feishuBackend = {
  /** 仅桌面端可用；浏览器态调用方据此给出提示而非静默失败。 */
  supported: (): boolean => isTauriRuntime(),

  async status(): Promise<FeishuStatus> {
    return invoke<FeishuStatus>("feishu_status");
  },

  /** 保存凭证；`appSecret` 传空串表示只改 AppID（沿用已存密钥）。 */
  async saveCredentials(appId: string, appSecret: string): Promise<FeishuStatus> {
    return invoke<FeishuStatus>("feishu_save_credentials", {
      appId,
      appSecret: appSecret.trim() ? appSecret : null,
    });
  },

  /** 发起扫码创建应用（不必先去控制台手工建应用）。 */
  async registerBegin(): Promise<FeishuRegisterStart> {
    return invoke<FeishuRegisterStart>("feishu_register_begin");
  },

  /** 轮询扫码结果；成功那一轮宿主会把 AppID/AppSecret 写好。 */
  async registerPoll(): Promise<FeishuRegisterPoll> {
    return invoke<FeishuRegisterPoll>("feishu_register_poll");
  },

  /** 放弃本次扫码（作废 device_code）。 */
  async registerCancel(): Promise<void> {
    await invoke("feishu_register_cancel");
  },

  /** 清除凭证与联系人档案（长连接随之停止）。 */
  async clearCredentials(): Promise<FeishuStatus> {
    return invoke<FeishuStatus>("feishu_clear_credentials");
  },

  /** 启动长连接；`allowOtherSenders` = 除归属人外也答复其他同事。 */
  async connect(allowOtherSenders: boolean): Promise<void> {
    await invoke("feishu_connect", { allowOtherSenders });
  },

  async disconnect(): Promise<void> {
    await invoke("feishu_disconnect");
  },

  /** 回一条文本（接收方信息在宿主侧，这里只传对端与文本）。 */
  async send(peerId: string, text: string): Promise<void> {
    await invoke("feishu_send", { peerId, text });
  },

  async onState(listener: (status: FeishuStatus) => void): Promise<UnlistenFn> {
    return listen<FeishuStatus>(FEISHU_STATE_EVENT, (event) => listener(event.payload));
  },

  async onInbound(listener: (message: FeishuInbound) => void): Promise<UnlistenFn> {
    return listen<FeishuInbound>(FEISHU_INBOUND_EVENT, (event) => listener(event.payload));
  },
};
