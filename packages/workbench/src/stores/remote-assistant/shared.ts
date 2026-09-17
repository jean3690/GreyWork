/**
 * 远程助手 store 的模块级基础：id 工厂、常量、类型、状态归一映射、联系人档案的
 * 持久化读写。全部不依赖 store 实例，index 直接原样再导出。
 */
import { createIdFactory, createJsonStorage } from "@greywork/core";
import type { DingTalkStatus } from "../../lib/dingtalk-backend";
import type { FeishuRegisterStart, FeishuStatus } from "../../lib/feishu-backend";
import type { WechatStatus } from "../../lib/wechat-backend";
import { i18n } from "../../i18n";

const t = i18n.global.t;
const aid = createIdFactory("wa");
const wid = createIdFactory("wm");

/** 活动流条数上限（页面只展示最近一屏）。 */
export const ACTIVITY_LIMIT = 20;
/** 单轮回复的保险丝：LLM 流 / ACP 回合挂死时不能让队列永远钉住。 */
export const REPLY_FUSE_MS = 120_000;
/** 扫码状态轮询连续失败几次后放弃（单次失败多是瞬断，重试即可）。 */
export const QR_POLL_MAX_FAILURES = 5;
export const QR_POLL_RETRY_MS = 2_000;
/** 两次扫码轮询之间的最小间隔：防止宿主秒回时把等待变成热循环。 */
export const QR_POLL_MIN_INTERVAL_MS = 1_000;

export type WechatQrPhase = "wait" | "scaned";
export interface WechatQrView {
  /** 待编码成二维码的链接文本。 */
  content: string;
  phase: WechatQrPhase;
}

/** 消息通道标识（与宿主命令 / 事件名前缀同名）。 */
export type RemoteChannel = "wechat" | "dingtalk" | "feishu";

/**
 * 通道状态的统一形状：微信（扫码登录态）与钉钉（应用凭证 + 长连接）各自映射进来，
 * 界面只认这一份，不必给每个通道写一套分支。
 */
export interface ChannelStatus {
  /** 是否具备连接条件：微信 = 已扫码登录；钉钉 = 已保存应用凭证。 */
  ready: boolean;
  state: "stopped" | "connecting" | "connected" | "paused" | "error";
  detail: string | null;
  lastMessageAt: number | null;
  /** 展示用账号标识：微信 = 扫码者 id，钉钉 = clientId。 */
  account: string | null;
}

export function idleChannelStatus(): ChannelStatus {
  return { ready: false, state: "stopped", detail: null, lastMessageAt: null, account: null };
}

export function wechatChannelStatus(status: WechatStatus | undefined): ChannelStatus {
  if (!status) return idleChannelStatus();
  return {
    ready: status.loggedIn,
    state: status.state,
    detail: status.detail,
    lastMessageAt: status.lastMessageAt,
    account: status.userId,
  };
}

export function feishuChannelStatus(status: FeishuStatus | undefined): ChannelStatus {
  if (!status) return idleChannelStatus();
  return {
    ready: status.configured,
    state: status.state,
    detail: status.detail,
    lastMessageAt: status.lastMessageAt,
    account: status.appId,
  };
}

export function dingtalkChannelStatus(status: DingTalkStatus | undefined): ChannelStatus {
  if (!status) return idleChannelStatus();
  return {
    ready: status.configured,
    state: status.state,
    detail: status.detail,
    lastMessageAt: status.lastMessageAt,
    account: status.clientId,
  };
}

export type RemoteActivityKind = "text" | "unsupported" | "error" | "system";
export interface RemoteActivity {
  id: string;
  direction: "in" | "out";
  /** 所属通道（活动流按通道打标）。 */
  channel: RemoteChannel;
  /** 对端展示名。 */
  peer: string;
  text: string;
  kind: RemoteActivityKind;
  at: number;
}

export const IDLE_STATUS: WechatStatus = {
  loggedIn: false,
  userId: null,
  botId: null,
  state: "stopped",
  detail: null,
  lastMessageAt: null,
  pendingLogin: false,
};

export const IDLE_FEISHU_STATUS: FeishuStatus = {
  configured: false,
  appId: null,
  state: "stopped",
  detail: null,
  lastMessageAt: null,
  peerCount: 0,
};

/** 飞书「扫码创建应用」的界面状态（凭证由宿主落盘，这里只有引导与结果）。 */
export interface FeishuRegisterView {
  phase: "idle" | "waiting" | "done" | "failed";
  /** 待扫的二维码链接（`waiting` 阶段才有）。 */
  qrUrl: string | null;
  /** 手机上的配对码，便于确认扫的是哪一次。 */
  userCode: string | null;
  detail: string | null;
}

export const IDLE_FEISHU_REGISTER: FeishuRegisterView = {
  phase: "idle",
  qrUrl: null,
  userCode: null,
  detail: null,
};

export const IDLE_DINGTALK_STATUS: DingTalkStatus = {
  configured: false,
  clientId: null,
  state: "stopped",
  detail: null,
  lastMessageAt: null,
  peerCount: 0,
};

/** 一个联系人（对端）在桌面端的档案：会话、回发凭据与最近往来。 */
export interface RemotePeer {
  /** 所属通道。 */
  channel: RemoteChannel;
  /** 通道内的对端标识：微信是 `xxx@im.wechat`，钉钉是员工 id / 会话 id。 */
  id: string;
  /** 展示名（钉钉有昵称；微信只有 id）。 */
  nick: string;
  /** 该联系人的会话 id（消息落在这里，桌面端可回看整段往来）。 */
  sessionId: string;
  /**
   * 最近一条入站消息的 `context_token`（仅微信；协议规定回发必须原样带上它）。
   * 钉钉的回复凭据（sessionWebhook）留在宿主，这里恒为 null。
   */
  contextToken: string | null;
  lastAt: number;
  lastText: string;
  /** 桌面端读到的时间戳：`lastAt > readAt` 即未读（页面上的小圆点）。 */
  readAt: number;
}

interface PeerArchive {
  peers: RemotePeer[];
}

/**
 * 档案校验（localStorage 边界）：数组 + 每项带 id/sessionId 即接受。
 * 这份存储是本功能自己的，v1 记录只缺 channel/nick，读入时补齐（见 readPeerArchive）。
 */
function isPeerArchive(value: unknown): value is PeerArchive {
  if (typeof value !== "object" || value === null || !("peers" in value)) return false;
  const peers: unknown = value.peers;
  return Array.isArray(peers) && peers.every((peer) => typeof peer === "object" && peer !== null && "id" in peer && "sessionId" in peer);
}

const peerArchiveStorage = createJsonStorage<PeerArchive>("greywork.remote-assistant.peers", isPeerArchive);

/** 读档案：v1 记录只存过微信联系人（没有 channel/nick），读入时补默认值。 */
export function readPeerArchive(): RemotePeer[] {
  const stored = peerArchiveStorage.read()?.peers ?? [];
  return stored.map((peer) => ({
    ...peer,
    channel: peer.channel === "dingtalk" ? "dingtalk" : "wechat",
    nick: typeof peer.nick === "string" && peer.nick ? peer.nick : peerLabel(peer.id),
  }));
}

/** 写档案（peer 增删改都从这里走）。 */
export function writePeerArchive(peers: RemotePeer[]): void {
  peerArchiveStorage.write({ peers });
}

/** 联系人主键：通道内唯一即可，跨通道必须区分。 */
export function peerKey(peer: Pick<RemotePeer, "channel" | "id">): string {
  return `${peer.channel}:${peer.id}`;
}

/** 微信 user id（`xxx@im.wechat`）→ 展示短名。 */
export function peerLabel(userId: string): string {
  const local = userId.split("@")[0] ?? userId;
  return local.length > 12 ? `${local.slice(0, 12)}…` : local;
}

/** 错误收敛成一行文案（失败详情 / 活动流落文本用）。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * 入站消息的统一形状：两条通道的差异（微信的 itemTypes + context_token、
 * 钉钉的 msgType + 宿主侧 webhook）在各自的 handler 里收敛掉，回复管线只认这一份。
 */
export interface InboundMessage {
  channel: RemoteChannel;
  peerId: string;
  nick: string;
  text: string;
  /** 微信：回发凭据；钉钉恒为 null（凭据在宿主）。 */
  contextToken: string | null;
  /** 非文本消息的类型说明（微信给数字类型集合，钉钉给 msgtype）。 */
  unsupportedLabel: string;
  at: number;
}

export { t, aid, wid };
export type { FeishuRegisterStart };
