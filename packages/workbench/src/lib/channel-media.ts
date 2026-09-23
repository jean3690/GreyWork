/**
 * 远程通道媒体收发的渲染端入口：一对通用命令 + 能力矩阵。
 *
 * 宿主侧只有 `channel_take_media` / `channel_send_media` 两个命令（按 `channel` 分发），
 * 所以这里也不需要给七条通道各写一套 `takeMedia` / `sendMedia`。能力矩阵来自宿主
 * （协议事实的唯一来源），渲染端只用它做提前告知，真正的拦截在宿主侧。
 */

import { invoke } from "@tauri-apps/api/core";

import { binaryPayload } from "../state/workspaceFiles";
import type { ChannelMediaCapability, MediaKind } from "../types";

const ALL_KINDS: MediaKind[] = ["image", "video", "audio", "file"];

/** 取不到宿主矩阵时的兜底（与 `channel_media::capability_of` 同口径）。 */
export function defaultChannelMediaCapability(channel: string): ChannelMediaCapability {
  switch (channel) {
    case "wechat":
      return { inbound: ALL_KINDS, outbound: ["image", "video", "file"] };
    case "telegram":
    case "discord":
      return { inbound: ALL_KINDS, outbound: ALL_KINDS };
    case "feishu":
      return { inbound: ALL_KINDS, outbound: ["image", "file"] };
    case "qq":
      return { inbound: ALL_KINDS, outbound: ["image", "video", "file"] };
    case "wecom":
      return { inbound: ["image", "video", "file"], outbound: ["image"] };
    case "dingtalk":
      return { inbound: ALL_KINDS, outbound: [] };
    default:
      return { inbound: [], outbound: [] };
  }
}

/**
 * 该能力下这种媒体能不能出站（与宿主 `capability_allows` 同口径）。
 *
 * 原生支持即可发；否则只要这条通道能发文件，就把视频 / 语音当文件发 —— 真正的降级改写
 * 在宿主 `channel_send_media`，这里只负责「提前告知」。
 */
export function channelMediaAllows(cap: ChannelMediaCapability, kind: MediaKind): boolean {
  if (cap.outbound.includes(kind)) return true;
  return kind !== "file" && cap.outbound.includes("file");
}

export const channelMediaBackend = {
  /** 各通道的媒体能力矩阵（宿主直出）；调用失败时调用方保留默认值。 */
  async capabilities(): Promise<Record<string, ChannelMediaCapability>> {
    return invoke<Record<string, ChannelMediaCapability>>("channel_media_capabilities");
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
   * 发一条媒体（图片 / 视频 / 语音 / 文件）给某个联系人。
   *
   * `path` 必须是已授权路径（渲染端选过的文件、`~/.greyWork` 下的附件）；`kind` 省略时
   * 由宿主按扩展名 / 魔数判类。`contextToken` 只有微信需要（回信凭据按条颁发），其余通道不传。
   */
  async sendMedia(channel: string, peerId: string, path: string, kind?: MediaKind, contextToken?: string): Promise<void> {
    await invoke("channel_send_media", {
      channel,
      peerId,
      path,
      kind: kind ?? null,
      contextToken: contextToken ?? null,
    });
  },
};
