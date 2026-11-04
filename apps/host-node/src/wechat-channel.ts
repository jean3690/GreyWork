/**
 * 微信通道：使用官方 `@wechatbot/wechatbot` Node SDK（iLink Bot API）。
 *
 * 与 Rust 的 `channels/wechat` 同语义：扫码登录 → 长轮询收信 → 消息/媒体收发。
 * SDK 自带凭据持久化（Storage 接口），Node 宿主只需创建实例并挂事件回调。
 */
import { WeChatBot } from "@wechatbot/wechatbot";

export interface WeChatChannel {
  bot: WeChatBot;
  connected: boolean;
}

/** 已连接的微信通道实例（按 dataDir 缓存，同进程复用）。 */
let instance: WeChatBot | null = null;
let connected = false;

export function getBot(storageDir: string): WeChatBot {
  if (instance) return instance;
  const bot = new WeChatBot({ storage: "file", storageDir });
  instance = bot;
  return bot;
}

export function isConnected(): boolean {
  return connected;
}

export function setConnected(value: boolean): void {
  connected = value;
}
