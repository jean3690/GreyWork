/**
 * 远程通道媒体收发的渲染端入口：一对通用命令 + 能力矩阵。
 *
 * 宿主侧只有 `channel_take_media` / `channel_send_media` 两个命令（按 `channel` 分发），
 * 所以这里也不需要给七条通道各写一套 `takeMedia` / `sendMedia`。能力矩阵来自宿主
 * （协议事实的唯一来源），渲染端只用它做提前告知，真正的拦截在宿主侧。
 */

import { invoke } from "@tauri-apps/api/core";

import { binaryPayload } from "../state/workspaceFiles";
import type { MediaCapability } from "../types";

/** 取不到宿主矩阵时的兜底（与 `channel_media::capability_of` 同口径）。 */
export function defaultMediaCapability(channel: string): MediaCapability {
  switch (channel) {
    case "wechat":
    case "telegram":
    case "discord":
    case "feishu":
    case "qq":
      return "both";
    case "wecom":
      return "imageOnly";
    case "dingtalk":
      return "inboundOnly";
    default:
      return "none";
  }
}

/** 该能力下这种媒体能不能出站（与宿主 `capability_allows` 同口径）。 */
export function mediaCapabilityAllows(cap: MediaCapability, kind: "image" | "file"): boolean {
  if (cap === "both") return true;
  return cap === "imageOnly" && kind === "image";
}

export const channelMediaBackend = {
  /** 各通道的媒体能力矩阵（宿主直出）；调用失败时调用方保留默认值。 */
  async capabilities(): Promise<Record<string, MediaCapability>> {
    return invoke<Record<string, MediaCapability>>("channel_media_capabilities");
  },

  /**
   * 从该通道的宿主收件目录取走一条入站媒体的**原始字节**（取走后宿主删除该文件）。
   *
   * 走 `tauri::ipc::Response` 而不是 base64：20MB 的图片转 base64 会膨胀 33% 再解码一遍。
   * 渲染端拿到字节后交 `materializeAttachments` 落进会话附件库。
   */
  async takeMedia(channel: string, path: string): Promise<Uint8Array> {
    return binaryPayload(await invoke<ArrayBuffer | Uint8Array>("channel_take_media", { channel, path }), "channel_take_media");
  },

  /**
   * 发一条媒体（图片 / 文件）给某个联系人。
   *
   * `path` 必须是已授权路径（渲染端选过的文件、`~/.greyWork` 下的附件）；`kind` 省略时
   * 由宿主按魔数嗅探。`contextToken` 只有微信需要（回信凭据按条颁发），其余通道不传。
   */
  async sendMedia(channel: string, peerId: string, path: string, kind?: "image" | "file", contextToken?: string): Promise<void> {
    await invoke("channel_send_media", {
      channel,
      peerId,
      path,
      kind: kind ?? null,
      contextToken: contextToken ?? null,
    });
  },
};
