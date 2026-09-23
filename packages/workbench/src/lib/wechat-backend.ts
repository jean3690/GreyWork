/**
 * 微信通道（腾讯 iLink Bot API）的宿主通道。
 *
 * 渲染端 CSP 不含外网域名，长轮询与扫码登录只能经 Rust 命令（`wechat.rs`）；
 * 浏览器态没有宿主，调用方需先看 `supported()` 再降级。
 *
 * 协议要点（宿主侧实现，这里只做形状声明）：
 * - 扫码登录：`get_bot_qrcode` 取二维码内容 → `get_qrcode_status` 长轮询等确认；
 * - 收消息：`getupdates` 长轮询（服务端最多持有 ~35s），游标 `get_updates_buf` 由宿主持久化；
 * - 回消息：`sendmessage`，必须原样带上入站消息的 `contextToken`，否则关联不到会话。
 *
 * 媒体（图片 / 文件）不进事件载荷：宿主下载解密后落在自己的 inbox 目录，事件只带路径，
 * 渲染端凭通用命令 `channel_take_media` 取原始字节（取走即删）；出站走 `channel_send_media`，
 * 加密上传全在宿主侧。两者都在 `lib/channel-media.ts`，不由本模块暴露。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "@greywork/core";

import type { MediaRef } from "../types";

/** 宿主侧通道状态机；`paused` = 服务端判会话过期（errcode -14）后的一小时冷却。 */
export type WechatState = "stopped" | "connecting" | "connected" | "paused" | "error";

export interface WechatStatus {
  /** 本机是否存有扫码登录得到的凭证。 */
  loggedIn: boolean;
  /** 扫码者（ilink_user_id）：默认只答复这个人。 */
  userId: string | null;
  /** bot 自身 id（ilink_bot_id）。 */
  botId: string | null;
  state: WechatState;
  /** 状态说明（错误原因 / 暂停剩余时间等）。 */
  detail: string | null;
  /** 最近一次收到消息的时间戳（epoch ms）；从未收到为 null。 */
  lastMessageAt: number | null;
  /** 是否有进行中的扫码会话（设置面板据此恢复二维码视图）。 */
  pendingLogin: boolean;
}

/** `wechat_login_qr` 的返回：content 是要编码成二维码的链接文本。 */
export interface WechatQrStart {
  content: string;
}

/**
 * `wechat_login_poll` 的返回；`expired` 且带 qrContent = 宿主已自动刷新出新码。
 *
 * `scaned`（已扫码待确认）由 SDK 的登录回路内部消化、不对外暴露，故宿主不会产出该状态。
 */
export interface WechatLoginPoll {
  status: "wait" | "scaned" | "confirmed" | "expired";
  qrContent?: string;
  userId?: string;
  botId?: string;
  /** 终止性说明（多次过期后放弃等）。 */
  detail?: string;
}

/** 入站消息：宿主已按「只放行本人（或用户显式允许）的发送者」过滤。 */
export interface WechatInbound {
  fromUserId: string;
  contextToken: string;
  /** 文本内容；语音会取云端转写文本。非文本消息为空串。 */
  text: string;
  /** item_list 的类型集合（1 文本 / 2 图片 / 3 语音 / 4 文件 / 5 视频）。 */
  itemTypes: number[];
  /** 已下载解密的媒体（图片 / 文件）。下载失败或未支持的类型不在其中。 */
  media?: MediaRef[];
  createTimeMs: number | null;
  /** 宿主收到消息的时刻（epoch ms）。 */
  at: number;
}

export const WECHAT_STATE_EVENT = "wechat://state";
export const WECHAT_INBOUND_EVENT = "wechat://inbound";

export const wechatBackend = {
  /** 仅桌面端可用；浏览器态调用方据此给出提示而非静默失败。 */
  supported: (): boolean => isTauriRuntime(),

  async status(): Promise<WechatStatus> {
    return invoke<WechatStatus>("wechat_status");
  },

  /** 申请登录二维码；宿主会作废上一个未完成的扫码会话。 */
  async loginQr(): Promise<WechatQrStart> {
    return invoke<WechatQrStart>("wechat_login_qr");
  },

  /** 长轮询一次扫码状态（宿主侧 35s 超时 → `wait`）。 */
  async loginPoll(): Promise<WechatLoginPoll> {
    return invoke<WechatLoginPoll>("wechat_login_poll");
  },

  /** 取消扫码会话（关闭二维码视图时调用）。 */
  async loginCancel(): Promise<void> {
    await invoke("wechat_login_cancel");
  },

  /** 启动收消息长轮询；`allowOtherSenders` = 除扫码者外也答复其他联系人。 */
  async connect(allowOtherSenders: boolean): Promise<void> {
    await invoke("wechat_connect", { allowOtherSenders });
  },

  /** 停止收消息（保留登录态，下次可直接重连）。 */
  async disconnect(): Promise<void> {
    await invoke("wechat_disconnect");
  },

  /** 退出登录：停轮询 + 删除本机凭证，恢复需重新扫码。 */
  async logout(): Promise<void> {
    await invoke("wechat_logout");
  },

  /** 回复一条文本；contextToken 必须来自对应入站消息。 */
  async send(toUserId: string, contextToken: string, text: string): Promise<void> {
    await invoke("wechat_send", { toUserId, contextToken, text });
  },

  /** 「正在输入」指示（失败可忽略：它只是体验增强）。取消由微信自行超时，宿主侧是 no-op。 */
  async sendTyping(toUserId: string, typing: boolean): Promise<void> {
    await invoke("wechat_send_typing", { toUserId, typing });
  },

  /** 订阅宿主状态变化；返回解绑函数。 */
  async onState(listener: (status: WechatStatus) => void): Promise<UnlistenFn> {
    return listen<WechatStatus>(WECHAT_STATE_EVENT, (event) => listener(event.payload));
  },

  /** 订阅入站消息；返回解绑函数。 */
  async onInbound(listener: (message: WechatInbound) => void): Promise<UnlistenFn> {
    return listen<WechatInbound>(WECHAT_INBOUND_EVENT, (event) => listener(event.payload));
  },
};
