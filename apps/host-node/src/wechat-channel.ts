/**
 * 微信通道：使用官方 `@wechatbot/wechatbot` Node SDK（iLink Bot API）。
 *
 * 与 Rust 的 `channels/wechat` 同语义：扫码登录 → 长轮询收信 → 消息/媒体收发。
 * SDK 自带凭据持久化（Storage 接口），Node 宿主只需创建实例并挂事件回调。
 *
 * 关键约束：SDK 的 file storage 目录必须**唯一且固定**为 `<dataDir>/wechat` ——
 * 它写的 `credentials.json` 正是 `channel-credentials.ts` 读的那一份。此前登录用
 * `path.join(dataDir,"wechat")`、连接却用 `dataDir`，单例先被谁创建就定死目录，
 * 导致连上时读不到凭证。现在统一从 dataDir 推导，杜绝两处口径分叉。
 */
import path from "node:path";

import { WeChatBot } from "@wechatbot/wechatbot";

/** SDK 的 file storage 根目录（与其它通道的 `<dataDir>/<channel>` 对齐）。 */
export function wechatStorageDir(dataDir: string): string {
  return path.join(dataDir, "wechat");
}

let instance: WeChatBot | null = null;
let instanceDir: string | null = null;

/** 取（或按 dataDir 重建）SDK 实例。传入的始终是宿主 dataDir，不是 wechat 子目录。 */
export function getBot(dataDir: string): WeChatBot {
  const dir = wechatStorageDir(dataDir);
  if (instance && instanceDir === dir) return instance;
  instance = new WeChatBot({ storage: "file", storageDir: dir });
  instanceDir = dir;
  return instance;
}

/** 停长轮询但保留实例与登录态（断开连接用）。 */
export function stopBot(): void {
  try {
    instance?.stop();
  } catch {
    // 已停。
  }
}

/** 丢掉整个实例（退出登录用）：SDK 没有 logout，只有重建才能清掉它内部的凭证缓存。 */
export function dropBot(): void {
  try {
    instance?.stop();
  } catch {
    // 已停。
  }
  instance = null;
  instanceDir = null;
}
