/**
 * 远程助手 · 入站适配：把 7 条通道各自的入站事件收敛成一个 [`InboundMessage`]，
 * 记入联系人档案与活动流，再交给串行队列排队回复。
 *
 * 从 `pipeline.ts` 拆出（P5 大文件拆分）：各通道的字段名差异只在这一层抹平，
 * 下游（回复管线）只面对统一的 InboundMessage。
 */
import type { MediaRef } from "../../types";
import type { DingTalkInbound } from "../../lib/dingtalk-backend";
import type { FeishuInbound } from "../../lib/feishu-backend";
import type { DiscordInbound } from "../../lib/discord-backend";
import type { QqInbound } from "../../lib/qq-backend";
import type { TelegramInbound } from "../../lib/telegram-backend";
import type { WecomInbound } from "../../lib/wecom-backend";
import type { WechatInbound } from "../../lib/wechat-backend";
import { peerKey, peerLabel, t, type InboundMessage, type RemotePeer } from "./shared";
import type { RemoteAssistantState } from "./state";
import type { StatusApi } from "./status";
import type { PeersApi } from "./peers";

export interface InboundDeps {
  settings: RemoteAssistantState["settings"];
  getPeers: () => PeersApi;
  getStatus: () => StatusApi;
  /** 串行队列：同一时间只跑一轮回复（由 pipeline 提供，保证跨入站有序）。 */
  enqueue: (task: () => Promise<void>) => void;
  /** 一轮回复的实现（由 pipeline 提供；此处只负责把入站排进队列）。 */
  replyTo: (peer: RemotePeer, message: InboundMessage) => Promise<void>;
}

export interface InboundApi {
  onWechatInbound(message: WechatInbound): void;
  onDingTalkInbound(message: DingTalkInbound): void;
  onFeishuInbound(message: FeishuInbound): void;
  onTelegramInbound(message: TelegramInbound): void;
  onQqInbound(message: QqInbound): void;
  onDiscordInbound(message: DiscordInbound): void;
  onWecomInbound(message: WecomInbound): void;
}

export function createInboundHandlers({ settings, getPeers, getStatus, enqueue, replyTo }: InboundDeps): InboundApi {
  /** 入站媒体在活动流 / 档案里的短标签（单条给具体类型，多条只报数量）。 */
  function mediaLabel(refs: readonly MediaRef[]): string {
    const [only] = refs;
    if (refs.length === 1 && only) {
      switch (only.kind) {
        case "image":
          return t("remoteAssist.media.imageInbound");
        case "video":
          return t("remoteAssist.media.videoInbound", { name: only.name });
        case "audio":
          return t("remoteAssist.media.audioInbound", { name: only.name });
        default:
          return t("remoteAssist.media.fileInbound", { name: only.name });
      }
    }
    return t("remoteAssist.media.inbound", { count: refs.length });
  }

  /** 记录一条入站并刷新联系人档案（回发凭据随消息更新）。 */
  function ingestInbound(message: InboundMessage): RemotePeer {
    const key = peerKey({ channel: message.channel, id: message.peerId });
    const media = message.mediaRefs ?? [];
    const description =
      message.text.trim() || (media.length ? mediaLabel(media) : t("remoteAssist.wechat.unsupported", { types: message.unsupportedLabel }));
    const existing = getPeers().peerByKey(key);
    if (existing) {
      existing.contextToken = message.contextToken || existing.contextToken;
      existing.lastAt = message.at;
      existing.lastText = description;
      if (message.nick) existing.nick = message.nick;
      getPeers().peerSessionId(existing);
      getPeers().persistPeers();
      return existing;
    }
    const created: RemotePeer = {
      channel: message.channel,
      id: message.peerId,
      nick: message.nick || peerLabel(message.peerId),
      sessionId: "",
      contextToken: message.contextToken || null,
      lastAt: message.at,
      lastText: description,
      readAt: 0,
    };
    getPeers().peerSessionId(created);
    getPeers().persistPeers();
    return getPeers().peerByKey(key) as RemotePeer;
  }

  function handleInbound(message: InboundMessage): void {
    const peer = ingestInbound(message);
    const media = message.mediaRefs ?? [];
    if (message.text.trim()) {
      getStatus().recordActivity({ direction: "in", peer: peer.nick, channel: message.channel, text: message.text, kind: "text" });
    } else if (media.length) {
      getStatus().recordActivity({ direction: "in", peer: peer.nick, channel: message.channel, text: mediaLabel(media), kind: "media" });
    } else {
      getStatus().recordActivity({
        direction: "in",
        peer: peer.nick,
        channel: message.channel,
        text: t("remoteAssist.wechat.unsupported", { types: message.unsupportedLabel }),
        kind: "unsupported",
      });
    }
    if (!settings.remoteAssist.channels[message.channel].autoReply) return;
    enqueue(() => replyTo(peer, message));
  }

  function onWechatInbound(message: WechatInbound): void {
    handleInbound({
      channel: "wechat",
      peerId: message.fromUserId,
      nick: "",
      text: message.text,
      contextToken: message.contextToken,
      unsupportedLabel: message.itemTypes.join("/") || "?",
      mediaRefs: message.media ?? [],
      at: message.at,
    });
  }

  function onDingTalkInbound(message: DingTalkInbound): void {
    // 钉钉的非文本消息（picture / audio）也走同一条入站路径：图片落成 mediaRefs，
    // 其余（audio 等）文本为空 → 回一句只认文字。
    const isText = message.msgType === null || message.msgType === "text";
    handleInbound({
      channel: "dingtalk",
      peerId: message.peerId,
      nick: message.nick,
      text: isText ? message.text : "",
      contextToken: null,
      unsupportedLabel: message.msgType ?? "?",
      mediaRefs: message.media ?? [],
      at: message.at,
    });
  }

  function onFeishuInbound(message: FeishuInbound): void {
    // 同钉钉：非文本消息也走同一路径，图片 / 文件落成 mediaRefs，其余文本为空。
    const isText = message.messageType === null || message.messageType === "text";
    handleInbound({
      channel: "feishu",
      peerId: message.peerId,
      nick: message.nick,
      text: isText ? message.text : "",
      contextToken: null,
      unsupportedLabel: message.messageType ?? "?",
      mediaRefs: message.media ?? [],
      at: message.at,
    });
  }

  function onTelegramInbound(message: TelegramInbound): void {
    // 图片 / 文件 / 语音落成 mediaRefs；纯贴纸等没有可下载内容的仍只有空文本。
    handleInbound({
      channel: "telegram",
      peerId: message.peerId,
      nick: message.nick,
      text: message.text,
      contextToken: null,
      unsupportedLabel: "non-text",
      mediaRefs: message.media ?? [],
      at: message.at,
    });
  }

  function onDiscordInbound(message: DiscordInbound): void {
    handleInbound({
      channel: "discord",
      peerId: message.peerId,
      nick: message.nick,
      text: message.text,
      contextToken: null,
      unsupportedLabel: "non-text",
      mediaRefs: message.media ?? [],
      at: message.at,
    });
  }

  function onQqInbound(message: QqInbound): void {
    handleInbound({
      channel: "qq",
      peerId: message.peerId,
      nick: message.nick,
      text: message.text,
      contextToken: null,
      unsupportedLabel: "non-text",
      mediaRefs: message.media ?? [],
      at: message.at,
    });
  }

  function onWecomInbound(message: WecomInbound): void {
    // 非文本消息（图片 / 文件 / 语音）也走同一路径：图片 / 文件落成 mediaRefs。
    handleInbound({
      channel: "wecom",
      peerId: message.peerId,
      nick: message.nick,
      text: message.text,
      contextToken: null,
      unsupportedLabel: message.unsupported || "non-text",
      mediaRefs: message.media ?? [],
      at: message.at,
    });
  }

  return {
    onWechatInbound,
    onDingTalkInbound,
    onFeishuInbound,
    onTelegramInbound,
    onQqInbound,
    onDiscordInbound,
    onWecomInbound,
  };
}
