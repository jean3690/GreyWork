/**
 * 远程助手：消息通道的渲染端编排（微信 / 钉钉两条通道共用一套回复管线）。
 *
 * 职责边界：
 * - 宿主负责协议与连接：微信的扫码登录 + 长轮询（`wechat.rs`）、钉钉的 Stream 长连接
 *   （`dingtalk.rs`）；凭证都在宿主侧落盘，渲染端只拿得到「状态 + 文本」。
 * - 本 store 负责产品行为：连接流程的界面状态、把入站消息交给本机助手生成回复
 *   （回复后端二选一：本机模型供应商，或设置里指定的 ACP 后端）、把回复经原通道发回，
 *   并把来往记录留成「活动」、联系人档案与真实会话。
 *
 * 每个联系人一条会话（标题 `微信 · <短 id>` / `钉钉 · <昵称>`），桌面端可回看整段往来，
 * 也能在会话页直接手发消息。消息串行处理：同一时间只跑一轮回复。
 */
import { createIdFactory, createJsonStorage } from "@greywork/core";
import { createLlmClient, type LlmChatParams } from "@greywork/llm";
import type { AgentProviderConfig } from "@greywork/shell";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { i18n } from "../i18n";
import { dingtalkBackend, type DingTalkInbound, type DingTalkStatus } from "../lib/dingtalk-backend";
import {
  feishuBackend,
  type FeishuInbound,
  type FeishuRegisterPoll,
  type FeishuRegisterStart,
  type FeishuStatus,
} from "../lib/feishu-backend";
import { wechatBackend, type WechatInbound, type WechatLoginPoll, type WechatStatus } from "../lib/wechat-backend";
import { markdownToPlainText } from "../lib/wechat-text";
import type { ThreadMessage } from "../types";
import { useAgentStore } from "./agent";
import { buildLlmHistory, selectLlmProvider } from "./chat-llm";
import { notify } from "./notice";
import { useSessionStore } from "./session";
import { useSettingsStore } from "./settings";
import { useWorkspaceStore } from "./workspace";

const t = i18n.global.t;
const aid = createIdFactory("wa");
const wid = createIdFactory("wm");

/** 活动流条数上限（页面只展示最近一屏）。 */
const ACTIVITY_LIMIT = 20;
/** 单轮回复的保险丝：LLM 流 / ACP 回合挂死时不能让队列永远钉住。 */
const REPLY_FUSE_MS = 120_000;
/** 扫码状态轮询连续失败几次后放弃（单次失败多是瞬断，重试即可）。 */
const QR_POLL_MAX_FAILURES = 5;
const QR_POLL_RETRY_MS = 2_000;
/** 两次扫码轮询之间的最小间隔：防止宿主秒回时把等待变成热循环。 */
const QR_POLL_MIN_INTERVAL_MS = 1_000;

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

const IDLE_STATUS: WechatStatus = {
  loggedIn: false,
  userId: null,
  botId: null,
  state: "stopped",
  detail: null,
  lastMessageAt: null,
  pendingLogin: false,
};

const IDLE_FEISHU_STATUS: FeishuStatus = {
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

const IDLE_FEISHU_REGISTER: FeishuRegisterView = {
  phase: "idle",
  qrUrl: null,
  userCode: null,
  detail: null,
};

const IDLE_DINGTALK_STATUS: DingTalkStatus = {
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
function readPeerArchive(): RemotePeer[] {
  const stored = peerArchiveStorage.read()?.peers ?? [];
  return stored.map((peer) => ({
    ...peer,
    channel: peer.channel === "dingtalk" ? "dingtalk" : "wechat",
    nick: typeof peer.nick === "string" && peer.nick ? peer.nick : peerLabel(peer.id),
  }));
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * 入站消息的统一形状：两条通道的差异（微信的 itemTypes + context_token、
 * 钉钉的 msgType + 宿主侧 webhook）在各自的 handler 里收敛掉，回复管线只认这一份。
 */
interface InboundMessage {
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

export const useRemoteAssistantStore = defineStore("remote-assistant", () => {
  const settings = useSettingsStore();
  const sessionStore = useSessionStore();
  const workspaceStore = useWorkspaceStore();
  const llm = createLlmClient();

  /** 桌面端可用性：宿主通道自己判断（浏览器态为 false，两条通道一致）。 */
  const available = ref(wechatBackend.supported());
  const initialized = ref(false);
  /** 微信通道状态（宿主直出形状）。 */
  const status = ref<WechatStatus>({ ...IDLE_STATUS });
  /** 钉钉通道状态（宿主直出形状）。 */
  const dingtalkStatus = ref<DingTalkStatus>({ ...IDLE_DINGTALK_STATUS });
  /** 飞书通道状态（宿主直出形状）。 */
  const feishuStatus = ref<FeishuStatus>({ ...IDLE_FEISHU_STATUS });
  /** 飞书扫码创建应用的界面状态。 */
  const feishuRegister = ref<FeishuRegisterView>({ ...IDLE_FEISHU_REGISTER });
  const qr = ref<WechatQrView | null>(null);
  const qrError = ref<string | null>(null);
  const activity = ref<RemoteActivity[]>([]);
  /** 联系人档案（持久化）：会话绑定、回发凭据与最近往来。 */
  const peers = ref<RemotePeer[]>(readPeerArchive());

  /* ===== 通道状态 ===== */

  /** 按通道取归一状态：界面只认这一份，不必为每条通道写分支。 */
  function statusOf(channel: RemoteChannel): ChannelStatus {
    if (channel === "wechat") return wechatChannelStatus(status.value);
    if (channel === "dingtalk") return dingtalkChannelStatus(dingtalkStatus.value);
    return feishuChannelStatus(feishuStatus.value);
  }

  /** 该通道是否在收消息（微信长轮询 / 钉钉长连接在跑）。 */
  function connectedOf(channel: RemoteChannel): boolean {
    return statusOf(channel).state === "connected";
  }

  /** 微信通道是否已连接（既有调用点沿用此名）。 */
  const connected = computed(() => connectedOf("wechat"));

  async function refreshStatus(): Promise<WechatStatus> {
    if (!available.value) return status.value;
    status.value = await wechatBackend.status();
    return status.value;
  }

  async function refreshDingTalkStatus(): Promise<DingTalkStatus> {
    if (!available.value) return dingtalkStatus.value;
    const next = await dingtalkBackend.status();
    // 宿主没给快照（旧版本 / 半截响应）时不覆盖现有状态：状态面只做展示，别让它打崩界面。
    if (next) dingtalkStatus.value = next;
    return dingtalkStatus.value;
  }

  async function refreshFeishuStatus(): Promise<FeishuStatus> {
    if (!available.value) return feishuStatus.value;
    const next = await feishuBackend.status();
    if (next) feishuStatus.value = next;
    return feishuStatus.value;
  }

  /* ===== 活动流 ===== */

  function recordActivity(entry: Omit<RemoteActivity, "id" | "at">): void {
    activity.value.unshift({ id: aid(), at: Date.now(), ...entry });
    if (activity.value.length > ACTIVITY_LIMIT) activity.value.length = ACTIVITY_LIMIT;
  }

  /* ===== 微信 · 扫码登录 ===== */

  /** 递增即作废进行中的扫码轮询（取消 / 重开后旧循环自行退出）。 */
  let loginEpoch = 0;
  let loginFailures = 0;

  async function startLogin(): Promise<void> {
    if (!available.value) {
      notify({ kind: "warning", key: "wechat-runtime", title: t("remoteAssist.wechat.desktopOnly") });
      return;
    }
    const epoch = ++loginEpoch;
    qrError.value = null;
    loginFailures = 0;
    try {
      const started = await wechatBackend.loginQr();
      if (epoch !== loginEpoch) return;
      qr.value = { content: started.content, phase: "wait" };
      void pollLogin(epoch);
    } catch (error) {
      if (epoch !== loginEpoch) return;
      qrError.value = describeError(error);
      notify({ kind: "error", key: "wechat-login", title: t("remoteAssist.wechat.loginFailed"), detail: qrError.value });
    }
  }

  /** 扫码状态长轮询：一次调用在宿主侧最多挂 ~35s，服务端有状态变化即提前返回。 */
  async function pollLogin(epoch: number): Promise<void> {
    while (epoch === loginEpoch && qr.value) {
      let result: WechatLoginPoll;
      const startedAt = Date.now();
      try {
        result = await wechatBackend.loginPoll();
        loginFailures = 0;
      } catch (error) {
        if (epoch !== loginEpoch) return;
        loginFailures += 1;
        if (loginFailures >= QR_POLL_MAX_FAILURES) {
          qrError.value = describeError(error);
          qr.value = null;
          return;
        }
        await delay(QR_POLL_RETRY_MS);
        continue;
      }
      if (epoch !== loginEpoch) return;

      if (result.status === "confirmed") {
        qr.value = null;
        await refreshStatus();
        recordActivity({
          direction: "in",
          peer: t("remoteAssist.wechat.botName"),
          channel: "wechat",
          text: t("remoteAssist.wechat.loggedIn"),
          kind: "system",
        });
        notify({ kind: "success", key: "wechat-login", title: t("remoteAssist.wechat.loginSucceeded") });
        // 扫码成功后直接连上：用户的期待就是「扫完就能用」。
        await connect();
        return;
      }
      if (result.status === "expired") {
        if (result.qrContent) {
          // 宿主已自动换了新码：原地刷新继续等扫。
          qr.value = { content: result.qrContent, phase: "wait" };
          continue;
        }
        qr.value = null;
        qrError.value = result.detail ?? t("remoteAssist.wechat.qrExpired");
        return;
      }
      if (qr.value) qr.value.phase = result.status;
      // 服务端会 hold 住请求，正常情况下每轮都等满 ~30s；万一它秒回（异常网关 /
      // 宿主兜底路径），这里留出最小间隔，别把等待变成热循环。
      const elapsed = Date.now() - startedAt;
      if (elapsed < QR_POLL_MIN_INTERVAL_MS) await delay(QR_POLL_MIN_INTERVAL_MS - elapsed);
    }
  }

  function cancelLogin(): void {
    loginEpoch += 1;
    qr.value = null;
    qrError.value = null;
    if (available.value) void wechatBackend.loginCancel().catch(() => undefined);
  }

  /* ===== 连接 / 断开 / 退出 ===== */

  async function connect(): Promise<void> {
    if (!available.value || !status.value.loggedIn) return;
    try {
      await wechatBackend.connect(settings.remoteAssist.channels.wechat.allowOtherSenders);
      await refreshStatus();
    } catch (error) {
      notify({ kind: "error", key: "wechat-connect", title: t("remoteAssist.wechat.connectFailed"), detail: describeError(error) });
      await refreshStatus().catch(() => undefined);
    }
  }

  async function disconnect(): Promise<void> {
    if (!available.value) return;
    await wechatBackend.disconnect();
    await refreshStatus();
  }

  async function logout(): Promise<void> {
    if (!available.value) return;
    cancelLogin();
    await wechatBackend.logout();
    await refreshStatus();
    recordActivity({
      direction: "in",
      peer: t("remoteAssist.wechat.botName"),
      channel: "wechat",
      text: t("remoteAssist.wechat.loggedOut"),
      kind: "system",
    });
  }

  /* ===== 钉钉 · 凭证与连接 ===== */

  /** 保存应用凭证（clientId = AppKey；clientSecret 留空表示沿用已存密钥）。 */
  async function saveDingTalkCredentials(clientId: string, clientSecret: string): Promise<string | null> {
    if (!available.value) return t("remoteAssist.wechat.desktopOnly");
    try {
      dingtalkStatus.value = await dingtalkBackend.saveCredentials(clientId.trim(), clientSecret.trim());
      return null;
    } catch (error) {
      return describeError(error);
    }
  }

  async function connectDingTalk(): Promise<void> {
    if (!available.value || !dingtalkStatus.value.configured) return;
    try {
      await dingtalkBackend.connect(settings.remoteAssist.channels.dingtalk.allowOtherSenders);
      await refreshDingTalkStatus();
    } catch (error) {
      notify({ kind: "error", key: "dingtalk-connect", title: t("remoteAssist.dingtalk.connectFailed"), detail: describeError(error) });
      await refreshDingTalkStatus().catch(() => undefined);
    }
  }

  async function disconnectDingTalk(): Promise<void> {
    if (!available.value) return;
    await dingtalkBackend.disconnect();
    await refreshDingTalkStatus();
  }

  /** 清除凭证（相当于退出登录）：长连接停止，凭证与联系人回发凭据一并删除。 */
  async function clearDingTalkCredentials(): Promise<void> {
    if (!available.value) return;
    dingtalkStatus.value = await dingtalkBackend.clearCredentials();
    recordActivity({
      direction: "in",
      peer: t("remoteAssist.channels.dingtalk"),
      channel: "dingtalk",
      text: t("remoteAssist.dingtalk.cleared"),
      kind: "system",
    });
  }

  /* ===== 飞书 · 凭证与连接 ===== */

  /** 保存应用凭证（AppID；AppSecret 留空表示沿用已存密钥）。 */
  async function saveFeishuCredentials(appId: string, appSecret: string): Promise<string | null> {
    if (!available.value) return t("remoteAssist.wechat.desktopOnly");
    try {
      feishuStatus.value = await feishuBackend.saveCredentials(appId.trim(), appSecret.trim());
      return null;
    } catch (error) {
      return describeError(error);
    }
  }

  async function connectFeishu(): Promise<void> {
    if (!available.value || !feishuStatus.value.configured) return;
    try {
      await feishuBackend.connect(settings.remoteAssist.channels.feishu.allowOtherSenders);
      await refreshFeishuStatus();
    } catch (error) {
      notify({ kind: "error", key: "feishu-connect", title: t("remoteAssist.feishu.connectFailed"), detail: describeError(error) });
      await refreshFeishuStatus().catch(() => undefined);
    }
  }

  async function disconnectFeishu(): Promise<void> {
    if (!available.value) return;
    await feishuBackend.disconnect();
    await refreshFeishuStatus();
  }

  /* ===== 飞书 · 扫码创建应用 ===== */

  /** 递增即作废进行中的扫码轮询（取消 / 重开时旧循环自行退出）。 */
  let registerEpoch = 0;

  /** 发起扫码创建应用：出二维码 → 轮询到确认 → 宿主落盘，这里只刷新状态并连上。 */
  async function startFeishuRegistration(): Promise<void> {
    if (!available.value) return;
    const epoch = ++registerEpoch;
    feishuRegister.value = { ...IDLE_FEISHU_REGISTER, phase: "waiting" };
    let started: FeishuRegisterStart;
    try {
      started = await feishuBackend.registerBegin();
    } catch (error) {
      if (epoch !== registerEpoch) return;
      feishuRegister.value = { ...IDLE_FEISHU_REGISTER, phase: "failed", detail: describeError(error) };
      return;
    }
    if (epoch !== registerEpoch) return;
    feishuRegister.value = { phase: "waiting", qrUrl: started.qrUrl, userCode: started.userCode, detail: null };
    void pollFeishuRegistration(epoch, Math.max(started.interval * 1000, QR_POLL_MIN_INTERVAL_MS));
  }

  /** 轮询扫码结果；宿主给的间隔会被采纳（服务端要求放慢时会变大）。 */
  async function pollFeishuRegistration(epoch: number, intervalMs: number): Promise<void> {
    let wait = intervalMs;
    let failures = 0;
    while (epoch === registerEpoch && feishuRegister.value.phase === "waiting") {
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (epoch !== registerEpoch) return;
      let result: FeishuRegisterPoll;
      try {
        result = await feishuBackend.registerPoll();
        failures = 0;
      } catch (error) {
        if (epoch !== registerEpoch) return;
        failures += 1;
        if (failures < QR_POLL_MAX_FAILURES) continue;
        feishuRegister.value = { ...IDLE_FEISHU_REGISTER, phase: "failed", detail: describeError(error) };
        return;
      }
      if (epoch !== registerEpoch) return;
      if (result.intervalMs && result.intervalMs > 0) wait = Math.max(result.intervalMs, QR_POLL_MIN_INTERVAL_MS);
      if (result.state === "pending") continue;
      if (result.state === "done") {
        feishuRegister.value = { phase: "done", qrUrl: null, userCode: null, detail: null };
        notify({ kind: "success", key: "feishu-register", title: t("remoteAssist.feishu.registerDone") });
        await refreshFeishuStatus().catch(() => undefined);
        // 与手填凭证一致：存好就顺手连上，用户不必再点一次。
        await connectFeishu();
        return;
      }
      // 失败原因优先用服务端给的描述，没有就用本地文案。
      const fallback =
        result.state === "denied"
          ? t("remoteAssist.feishu.registerDenied")
          : result.state === "expired"
            ? t("remoteAssist.feishu.registerExpired")
            : t("remoteAssist.feishu.registerFailed");
      feishuRegister.value = { ...IDLE_FEISHU_REGISTER, phase: "failed", detail: result.detail ?? fallback };
      return;
    }
  }

  /** 取消扫码：作废宿主那边的 device_code，并让轮询循环退出。 */
  function cancelFeishuRegistration(): void {
    registerEpoch += 1;
    feishuRegister.value = { ...IDLE_FEISHU_REGISTER };
    if (!available.value) return;
    void feishuBackend.registerCancel().catch(() => undefined);
  }

  /** 清除凭证（相当于退出登录）：长连接停止，凭证与联系人档案一并删除。 */
  async function clearFeishuCredentials(): Promise<void> {
    if (!available.value) return;
    feishuStatus.value = await feishuBackend.clearCredentials();
    recordActivity({
      direction: "in",
      peer: t("remoteAssist.channels.feishu"),
      channel: "feishu",
      text: t("remoteAssist.feishu.cleared"),
      kind: "system",
    });
  }

  /** 发送者策略变更后调用：该通道已连接则重连一次，让宿主换用新策略。 */
  async function applySenderPolicy(channel: RemoteChannel): Promise<void> {
    if (!available.value) return;
    const state = statusOf(channel).state;
    if (state !== "connected" && state !== "connecting") return;
    if (channel === "wechat") {
      await wechatBackend.disconnect();
      await connect();
      return;
    }
    if (channel === "dingtalk") {
      await dingtalkBackend.disconnect();
      await connectDingTalk();
      return;
    }
    await feishuBackend.disconnect();
    await connectFeishu();
  }

  /* ===== 联系人档案 ===== */

  function persistPeers(): void {
    peerArchiveStorage.write({ peers: peers.value });
  }

  function peerByKey(key: string): RemotePeer | undefined {
    return peers.value.find((peer) => peerKey(peer) === key);
  }

  /** 联系人列表（最近有往来在前）。 */
  const peerList = computed(() => [...peers.value].sort((left, right) => right.lastAt - left.lastAt));

  /** 标记读到最新（会话页挂载 / 新消息到达且正在看时调用）。 */
  function markPeerRead(key: string): void {
    const peer = peerByKey(key);
    if (!peer || peer.readAt >= peer.lastAt) return;
    peer.readAt = peer.lastAt;
    persistPeers();
  }

  /**
   * 联系人 → 会话：已有会话沿用；没有则新建并把激活位还原
   * （收消息不该把用户正在看的会话切走）。
   */
  function peerSessionId(peer: RemotePeer): string {
    const existing = peerByKey(peerKey(peer));
    if (existing && sessionStore.getSession(existing.sessionId)) return existing.sessionId;

    const previousActive = sessionStore.activeSessionId;
    const channelName = t(`remoteAssist.channels.${peer.channel}`);
    const session = sessionStore.createSession(workspaceStore.activeWorkspaceId, `${channelName} · ${peer.nick}`);
    sessionStore.setActive(previousActive);
    if (existing) existing.sessionId = session.id;
    else peers.value = [...peers.value, { ...peer, sessionId: session.id }];
    persistPeers();
    return session.id;
  }

  function appendRemoteMessage(sessionId: string, role: "user" | "assistant", content: string): ThreadMessage {
    const message: ThreadMessage = { id: wid(), role, content, ts: Date.now() };
    sessionStore.appendMessage(sessionId, message);
    return message;
  }

  function readMessageContent(sessionId: string, messageId: string): string {
    const messages = sessionStore.getSession(sessionId)?.messages ?? [];
    return messages.find((message) => message.id === messageId)?.content ?? "";
  }

  /* ===== 入站 → 本机助手 → 回发 ===== */

  let queue: Promise<void> = Promise.resolve();

  /** 串行队列：同一时间只跑一轮回复，避免两条消息的回合交错写进同一会话。 */
  function enqueue(task: () => Promise<void>): void {
    queue = queue.then(task).catch((error: unknown) => {
      console.error("[remote-assistant] 队列任务失败", error);
    });
  }

  /** 记录一条入站并刷新联系人档案（回发凭据随消息更新）。 */
  function ingestInbound(message: InboundMessage): RemotePeer {
    const key = peerKey({ channel: message.channel, id: message.peerId });
    const description = message.text.trim() || t("remoteAssist.wechat.unsupported", { types: message.unsupportedLabel });
    const existing = peerByKey(key);
    if (existing) {
      existing.contextToken = message.contextToken || existing.contextToken;
      existing.lastAt = message.at;
      existing.lastText = description;
      if (message.nick) existing.nick = message.nick;
      peerSessionId(existing);
      persistPeers();
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
    peerSessionId(created);
    persistPeers();
    return peerByKey(key) as RemotePeer;
  }

  function handleInbound(message: InboundMessage): void {
    const peer = ingestInbound(message);
    if (!message.text.trim()) {
      recordActivity({
        direction: "in",
        peer: peer.nick,
        channel: message.channel,
        text: t("remoteAssist.wechat.unsupported", { types: message.unsupportedLabel }),
        kind: "unsupported",
      });
    } else {
      recordActivity({ direction: "in", peer: peer.nick, channel: message.channel, text: message.text, kind: "text" });
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
      at: message.at,
    });
  }

  function onDingTalkInbound(message: DingTalkInbound): void {
    // 钉钉的非文本消息（picture / audio）也走同一条入站路径，只是文本为空 → 回一句只认文字。
    const isText = message.msgType === null || message.msgType === "text";
    handleInbound({
      channel: "dingtalk",
      peerId: message.peerId,
      nick: message.nick,
      text: isText ? message.text : "",
      contextToken: null,
      unsupportedLabel: message.msgType ?? "?",
      at: message.at,
    });
  }

  function onFeishuInbound(message: FeishuInbound): void {
    // 同钉钉：非文本消息也走同一路径，只是文本为空 → 回一句只认文字。
    const isText = message.messageType === null || message.messageType === "text";
    handleInbound({
      channel: "feishu",
      peerId: message.peerId,
      nick: message.nick,
      text: isText ? message.text : "",
      contextToken: null,
      unsupportedLabel: message.messageType ?? "?",
      at: message.at,
    });
  }

  /* ===== LLM 管线（replyMode = llm） ===== */

  /* LLM 流：只认自己那一笔（clientToken），并把这轮的增量攒起来。 */
  let activeToken: string | null = null;
  let replyBuffer = "";
  let settleTurn: ((error: string | null) => void) | null = null;
  let llmListening = false;

  function finishTurn(error: string | null): void {
    const settle = settleTurn;
    settleTurn = null;
    activeToken = null;
    settle?.(error);
  }

  async function ensureLlmListener(): Promise<void> {
    if (llmListening) return;
    llmListening = true;
    await llm.onEvent((event) => {
      if (!activeToken || event.payload.clientToken !== activeToken) return;
      if (event.kind === "llm-delta") replyBuffer += event.payload.delta ?? "";
      else if (event.kind === "llm-done") finishTurn(null);
      else finishTurn(event.payload.message ?? "unknown");
    });
  }

  /** 跑一轮真实 LLM 流并返回完整文本；失败/超时经 error 返回给调用方记录。 */
  async function runLlmTurn(params: LlmChatParams): Promise<{ text: string; error: string | null }> {
    replyBuffer = "";
    activeToken = aid();
    const gate = Promise.withResolvers<string | null>();
    settleTurn = gate.resolve;
    let requestId: number | null = null;
    const timer = setTimeout(() => {
      // 超时不只是放弃等待：把宿主侧那条流也停掉，别让它在后台继续烧 token。
      if (requestId !== null) void llm.stop(requestId).catch(() => undefined);
      if (settleTurn) finishTurn(t("remoteAssist.wechat.replyTimeout"));
    }, REPLY_FUSE_MS);
    try {
      requestId = await llm.chat({ ...params, clientToken: activeToken ?? undefined });
      const error = await gate.promise;
      return { text: replyBuffer, error };
    } catch (error) {
      finishTurn(describeError(error));
      return { text: replyBuffer, error: describeError(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ===== ACP 管线（replyMode = acp） ===== */

  /** 本轮该用哪个 ACP 后端：设置里指定优先，否则跟随对话页当前选择。 */
  function resolveAcpProvider(): AgentProviderConfig | undefined {
    const agent = useAgentStore();
    const configured = settings.remoteAssist.replyProviderId;
    return agent.agentProviders.find((provider) => provider.id === (configured ?? agent.selectedProviderId));
  }

  /** 等 ACP 空闲：全局只有一个 ACP 会话，对话页的回合要先跑完（超时即放弃本轮）。 */
  async function waitForAcpIdle(timeoutMs: number): Promise<boolean> {
    const agent = useAgentStore();
    const deadline = Date.now() + timeoutMs;
    while (agent.acpBusy || agent.acpConnecting) {
      if (Date.now() >= deadline) return false;
      await delay(500);
    }
    return true;
  }

  /**
   * 跑一轮 ACP 回合：把用户消息与支架入到联系人会话里，
   * 回合结束（prompt-done / prompt 层异常）后读支架正文为终稿。
   */
  async function runAcpTurn(sessionId: string, text: string, providerName: string): Promise<{ text: string; error: string | null }> {
    const agent = useAgentStore();
    const scaffold = appendRemoteMessage(sessionId, "assistant", "");
    const gate = Promise.withResolvers<string | null>();
    let settled = false;
    const finish = (error: string | null): void => {
      if (settled) return;
      settled = true;
      gate.resolve(error);
    };
    const timer = setTimeout(() => finish(t("remoteAssist.wechat.replyTimeout")), REPLY_FUSE_MS);

    try {
      // 检查与调用之间没有 await：宿主侧「忙则静默早退」的窗口因此不存在。
      if (agent.acpBusy || agent.acpConnecting) {
        finish(t("remoteAssist.wechat.acpBusy"));
      } else {
        await agent.sendGlobalTurn(text, providerName, {
          reuseScaffold: { threadId: sessionId, message: scaffold },
          hooks: {
            onPromptDone: () => finish(null),
            onPromptError: () => {
              finish(null);
              return true; // 错误文案已由 ACP 支架自己写入，不再叠加默认提示
            },
          },
        });
      }
      const error = await gate.promise;
      return { text: readMessageContent(sessionId, scaffold.id), error };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ===== 回发 ===== */

  /** 按通道回发一条文本：微信带 context_token；钉钉由宿主用自己记的 sessionWebhook 发送。 */
  async function sendViaChannel(peer: RemotePeer, text: string): Promise<void> {
    if (peer.channel === "wechat") {
      const token = peer.contextToken;
      if (!token) throw new Error(t("remoteAssist.conversation.noContextToken"));
      await wechatBackend.send(peer.id, token, text);
    } else if (peer.channel === "dingtalk") {
      await dingtalkBackend.send(peer.id, text);
    } else {
      await feishuBackend.send(peer.id, text);
    }
    recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text, kind: "text" });
  }

  /** 桌面端在会话页手发一条（不经模型）：能否发取决于通道连接态与回发凭据。 */
  async function sendFromDesktop(key: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: t("remoteAssist.conversation.emptyDraft") };
    const peer = peerByKey(key);
    if (!peer) return { ok: false, error: t("remoteAssist.conversation.unknownPeer") };
    if (!connectedOf(peer.channel)) return { ok: false, error: t("remoteAssist.conversation.offlineHint") };
    if (peer.channel === "wechat" && !peer.contextToken) {
      return { ok: false, error: t("remoteAssist.conversation.noContextToken") };
    }
    appendRemoteMessage(peer.sessionId, "assistant", trimmed);
    try {
      await sendViaChannel(peer, trimmed);
    } catch (error) {
      const detail = describeError(error);
      recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text: detail, kind: "error" });
      return { ok: false, error: detail };
    }
    peer.lastText = trimmed;
    peer.lastAt = Date.now();
    peer.readAt = peer.lastAt;
    persistPeers();
    return { ok: true };
  }

  /** 「正在输入」只有微信协议支持；钉钉没有对应能力，静默跳过。 */
  async function signalTyping(peer: RemotePeer, typing: boolean): Promise<void> {
    if (peer.channel !== "wechat" || !peer.contextToken) return;
    await wechatBackend.sendTyping(peer.id, peer.contextToken, typing).catch(() => undefined);
  }

  /** 一轮回复的公共收尾：失败说明、空回复兜底、经原通道回发。 */
  async function deliver(peer: RemotePeer, sessionId: string, result: { text: string; error: string | null }): Promise<void> {
    await signalTyping(peer, false);
    if (result.error !== null && !result.text) {
      // 失败也要让对方知道原因（本机配置问题、超时、agent 忙），不能只是本机静默记一笔。
      const detail = result.error;
      appendRemoteMessage(sessionId, "assistant", t("remoteAssist.wechat.replyFailed", { detail }));
      recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text: detail, kind: "error" });
      await sendViaChannel(peer, detail).catch(() => undefined);
      return;
    }
    const plain = markdownToPlainText(result.text).trim() || t("remoteAssist.wechat.emptyReply");
    // 会话里存原文（本地可读 Markdown），通道里发纯文本（聊天窗不渲染标记）。
    appendRemoteMessage(sessionId, "assistant", result.text);
    try {
      await sendViaChannel(peer, plain);
    } catch (error) {
      recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text: describeError(error), kind: "error" });
    }
  }

  async function replyTo(peer: RemotePeer, message: InboundMessage): Promise<void> {
    const sessionId = peerSessionId(peer);
    if (!message.text.trim()) {
      // 非文本消息不喂模型：先如实告诉对方这一版只认文字。
      const notice = t("remoteAssist.wechat.unsupportedReply");
      appendRemoteMessage(sessionId, "user", notice);
      await sendViaChannel(peer, notice).catch((error: unknown) => {
        recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text: describeError(error), kind: "error" });
      });
      return;
    }

    appendRemoteMessage(sessionId, "user", message.text);
    await signalTyping(peer, true);

    if (settings.remoteAssist.replyMode === "acp") {
      const agent = useAgentStore();
      const provider = resolveAcpProvider();
      if (!provider) {
        await deliver(peer, sessionId, { text: "", error: t("remoteAssist.wechat.noAcpProvider") });
        return;
      }
      // 远程回合与对话页共用同一台 agent：设置里指定的后端在这里生效（含对话页的选择）。
      if (provider.id !== agent.selectedProviderId) agent.selectProvider(provider.id);
      if (!(await waitForAcpIdle(REPLY_FUSE_MS))) {
        await deliver(peer, sessionId, { text: "", error: t("remoteAssist.wechat.acpBusy") });
        return;
      }
      const turn = await runAcpTurn(sessionId, message.text, provider.name);
      await deliver(peer, sessionId, turn);
      return;
    }

    await ensureLlmListener();
    const provider = selectLlmProvider(settings.modelProviders, settings.selectedModelProviderId);
    if (!provider || !llm.isAvailable()) {
      const reason = t("remoteAssist.wechat.noProvider");
      appendRemoteMessage(sessionId, "assistant", reason);
      recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text: reason, kind: "error" });
      await sendViaChannel(peer, reason).catch(() => undefined);
      return;
    }

    const history = await buildLlmHistory(sessionStore.ensure(sessionId));
    const turn = await runLlmTurn({
      baseUrl: provider.baseUrl ?? "",
      model: provider.model,
      apiKeyEnv: provider.apiKeyEnv,
      messages: history,
      reasoningEffort: provider.reasoningEffort ?? "auto",
    });
    await deliver(peer, sessionId, turn);
  }

  /* ===== 启动接线 ===== */

  let listenersAttached = false;

  async function attachListeners(): Promise<void> {
    if (listenersAttached) return;
    listenersAttached = true;

    await wechatBackend.onState((next) => {
      const wasConnected = status.value.state === "connected";
      status.value = next;
      if (wasConnected && next.state !== "connected" && next.detail) {
        recordActivity({
          direction: "in",
          peer: t("remoteAssist.wechat.botName"),
          channel: "wechat",
          text: next.detail,
          kind: "error",
        });
      }
    });
    await wechatBackend.onInbound(onWechatInbound);

    await dingtalkBackend.onState((next) => {
      const wasConnected = dingtalkStatus.value.state === "connected";
      dingtalkStatus.value = next;
      if (wasConnected && next.state !== "connected" && next.detail) {
        recordActivity({
          direction: "in",
          peer: t("remoteAssist.channels.dingtalk"),
          channel: "dingtalk",
          text: next.detail,
          kind: "error",
        });
      }
    });
    await dingtalkBackend.onInbound(onDingTalkInbound);

    await feishuBackend.onState((next) => {
      const wasConnected = feishuStatus.value.state === "connected";
      feishuStatus.value = next;
      if (wasConnected && next.state !== "connected" && next.detail) {
        recordActivity({
          direction: "in",
          peer: t("remoteAssist.channels.feishu"),
          channel: "feishu",
          text: next.detail,
          kind: "error",
        });
      }
    });
    await feishuBackend.onInbound(onFeishuInbound);
  }

  /** 幂等启动：注册两条通道的事件、拉状态、按各自设置自动连接（由 Shell 挂载时调用）。 */
  async function init(): Promise<void> {
    if (initialized.value) return;
    initialized.value = true;
    available.value = wechatBackend.supported();
    if (!available.value) return;
    try {
      await attachListeners();
      await refreshStatus();
      // 钉钉同样只有桌面端有宿主命令；浏览器态跳过（保持状态为初始值）。
      await refreshDingTalkStatus().catch(() => undefined);
      await refreshFeishuStatus().catch(() => undefined);
    } catch (error) {
      console.error("[remote-assistant] 初始化失败", error);
      return;
    }
    if (settings.remoteAssist.channels.wechat.autoConnect && status.value.loggedIn && status.value.state !== "connected") {
      await connect();
    }
    if (
      settings.remoteAssist.channels.dingtalk.autoConnect &&
      dingtalkStatus.value.configured &&
      dingtalkStatus.value.state !== "connected"
    ) {
      await connectDingTalk();
    }
    if (settings.remoteAssist.channels.feishu.autoConnect && feishuStatus.value.configured && feishuStatus.value.state !== "connected") {
      await connectFeishu();
    }
  }

  return {
    available,
    status,
    connected,
    qr,
    qrError,
    activity,
    peers,
    peerList,
    peerById: peerByKey,
    markPeerRead,
    sendFromDesktop,
    statusOf,
    connectedOf,
    dingtalkStatus,
    feishuStatus,
    feishuRegister,
    startFeishuRegistration,
    cancelFeishuRegistration,
    saveFeishuCredentials,
    connectFeishu,
    disconnectFeishu,
    clearFeishuCredentials,
    refreshFeishuStatus,
    saveDingTalkCredentials,
    connectDingTalk,
    disconnectDingTalk,
    clearDingTalkCredentials,
    refreshDingTalkStatus,
    init,
    refreshStatus,
    startLogin,
    cancelLogin,
    connect,
    disconnect,
    logout,
    applySenderPolicy,
  };
});
