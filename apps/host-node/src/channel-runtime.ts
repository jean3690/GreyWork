/**
 * 聊天通道运行时：七条通道共用的连接状态机、事件广播、发送者策略与登出清理。
 *
 * Rust 宿主删库后，Node 宿主一度只剩「connect/disconnect 置内存标志」的桩：
 * `*_status` 恒报 stopped、没有 `://state` / `://inbound` 事件、`wechat_logout` 是空实现。
 * 这里把生命周期收拢到一处，各协议只负责「把帧变成入站消息」，见 channel-connectors.ts。
 *
 * 设计要点：
 * - 每次 connect 分配一个 AbortController，disconnect/logout 只 abort 它，连接器循环自行退出；
 * - 归属人 = 第一个发消息的人（按 senderId），"允许其他联系人" 只是放宽这一判定；
 * - 状态现算现查：凭证增删、连接态变化立刻反映到 `*_status` 与 `://state` 事件；
 * - 登出 = 停连接 + 删凭证 + 清收件目录 + 丢弃微信 SDK 实例，界面因此必然有可见变化。
 */
import type { EventBus } from "./events.js";
import { clearChannelCredentials, loadChannelCredentials, type ChannelName } from "./channel-credentials.js";
import { CONNECTORS } from "./channel-connectors.js";
import { str, type ChannelState, type Connector, type ConnectorContext, type RuntimeApi } from "./channel-common.js";
import { pruneInbox, wechatLoginPending } from "./channels.js";
import { dropBot, stopBot } from "./wechat-channel.js";

export const CHANNELS: readonly ChannelName[] = ["wechat", "dingtalk", "feishu", "telegram", "qq", "discord", "wecom"];

export function isChannelName(value: string): value is ChannelName {
  return (CHANNELS as readonly string[]).includes(value);
}

interface ChannelRecord {
  state: ChannelState;
  detail: string | null;
  lastMessageAt: number | null;
  peers: Set<string>;
  ownerId: string | null;
  allowOtherSenders: boolean;
  controller: AbortController | null;
}

function emptyRecord(): ChannelRecord {
  return {
    state: "stopped",
    detail: null,
    lastMessageAt: null,
    peers: new Set(),
    ownerId: null,
    allowOtherSenders: false,
    controller: null,
  };
}

export class ChannelRuntime implements RuntimeApi {
  private readonly records = new Map<ChannelName, ChannelRecord>();
  private readonly connectors: Record<ChannelName, Connector>;

  constructor(
    private readonly bus: EventBus,
    private readonly dataDir: string,
    connectors: Record<ChannelName, Connector> = CONNECTORS,
  ) {
    this.connectors = connectors;
  }

  private record(channel: ChannelName): ChannelRecord {
    let record = this.records.get(channel);
    if (!record) {
      record = emptyRecord();
      this.records.set(channel, record);
    }
    return record;
  }

  /* ===== 状态机 ===== */

  markConnected(channel: ChannelName, detail: string | null = null): void {
    const record = this.record(channel);
    record.state = "connected";
    record.detail = detail;
    this.emitState(channel);
  }

  markConnecting(channel: ChannelName): void {
    const record = this.record(channel);
    record.state = "connecting";
    record.detail = null;
    this.emitState(channel);
  }

  markError(channel: ChannelName, detail: string): void {
    const record = this.record(channel);
    record.state = "error";
    record.detail = detail;
    this.emitState(channel);
  }

  /** 停掉当前连接循环（不改状态、不广播，由调用方决定后续态）。 */
  private stop(channel: ChannelName): void {
    const record = this.record(channel);
    if (record.controller) {
      record.controller.abort();
      record.controller = null;
    }
    if (channel === "wechat") stopBot();
  }

  /** 连接：凭据缺失直接报错（避免「点了没反应」），否则后台起循环并立即置 connecting。 */
  connect(channel: ChannelName, allowOtherSenders: boolean, endpointOverride?: string): void {
    const record = this.record(channel);
    if (record.controller && record.allowOtherSenders === allowOtherSenders) return;
    this.stop(channel);
    const credentials = loadChannelCredentials(this.dataDir, channel);
    if (!credentials) {
      const hint = channel === "wechat" ? "请先扫码登录微信" : "通道凭据未配置，请先保存凭证";
      throw new Error(hint);
    }
    record.allowOtherSenders = allowOtherSenders;
    const controller = new AbortController();
    record.controller = controller;
    record.state = "connecting";
    record.detail = null;
    this.emitState(channel);
    const context: ConnectorContext = {
      runtime: this,
      channel,
      dataDir: this.dataDir,
      signal: controller.signal,
      allowOtherSenders,
      endpointOverride,
    };
    void this.run(channel, controller.signal, context);
  }

  private async run(channel: ChannelName, signal: AbortSignal, context: ConnectorContext): Promise<void> {
    try {
      await this.connectors[channel](context);
      if (!signal.aborted) this.markError(channel, "连接已结束");
    } catch (error) {
      if (!signal.aborted) this.markError(channel, error instanceof Error ? error.message : String(error));
    } finally {
      const record = this.record(channel);
      if (record.controller?.signal === signal) record.controller = null;
    }
  }

  disconnect(channel: ChannelName): void {
    this.stop(channel);
    const record = this.record(channel);
    record.state = "stopped";
    record.detail = null;
    this.emitState(channel);
  }

  /** 退出登录 / 清除凭证：停连接、删凭证、清收件目录与本地会话绑定，状态回 stopped。 */
  logout(channel: ChannelName): void {
    this.stop(channel);
    clearChannelCredentials(this.dataDir, channel);
    pruneInbox(this.dataDir, channel, true);
    if (channel === "wechat") {
      // SDK 没有 logout，只有丢掉整个实例才能清掉它内部的凭证缓存。
      dropBot();
    }
    const record = this.record(channel);
    Object.assign(record, emptyRecord());
    this.emitState(channel);
  }

  stopAll(): void {
    for (const channel of CHANNELS) this.stop(channel);
  }

  /* ===== 事件与状态面 ===== */

  emitState(channel: ChannelName): void {
    this.bus.broadcast(`${channel}://state`, this.status(channel));
  }

  emitInbound(channel: ChannelName, peerId: string, senderId: string, at: number, dto: unknown, allowOtherSenders: boolean): void {
    const record = this.record(channel);
    if (!record.ownerId) record.ownerId = senderId;
    record.peers.add(peerId);
    if (record.lastMessageAt === null || at > record.lastMessageAt) record.lastMessageAt = at;
    record.state = "connected";
    record.detail = null;
    this.emitState(channel);
    if (!allowOtherSenders && senderId !== record.ownerId) return;
    this.bus.broadcast(`${channel}://inbound`, dto);
  }

  /** 各通道的 StatusDto，与渲染端 lib/*-backend.ts 的形状逐字对齐。 */
  status(channel: ChannelName): Record<string, unknown> {
    const record = this.record(channel);
    const credentials = loadChannelCredentials(this.dataDir, channel);
    const configured = credentials !== null;
    const common = {
      configured,
      state: record.state,
      detail: record.detail,
      lastMessageAt: record.lastMessageAt,
    };
    switch (channel) {
      case "wechat":
        return {
          loggedIn: configured,
          userId: str(credentials?.userId),
          botId: str(credentials?.accountId),
          state: record.state,
          detail: record.detail,
          lastMessageAt: record.lastMessageAt,
          pendingLogin: wechatLoginPending(),
        };
      case "dingtalk":
        return { ...common, clientId: str(credentials?.clientId), peerCount: record.peers.size };
      case "feishu":
      case "qq":
        return { ...common, appId: str(credentials?.appId), peerCount: record.peers.size };
      case "discord":
        return { ...common, botUsername: str(credentials?.botUsername), peerCount: record.peers.size };
      case "wecom":
        return { ...common, botId: str(credentials?.botId), peerCount: record.peers.size };
      default:
        return { ...common, peerCount: record.peers.size };
    }
  }
}
