/**
 * 通道状态切片：把微信 / 钉钉 / 飞书三条宿主管道的原始状态归一成一份界面形状，
 * 并提供刷新入口与活动流记录。纯函数切片，不依赖其他切片。
 */
import { computed, type ComputedRef } from "vue";
import type { DingTalkStatus } from "../../lib/dingtalk-backend";
import { dingtalkBackend } from "../../lib/dingtalk-backend";
import type { FeishuStatus } from "../../lib/feishu-backend";
import { feishuBackend } from "../../lib/feishu-backend";
import { discordBackend, type DiscordStatus } from "../../lib/discord-backend";
import { qqBackend, type QqStatus } from "../../lib/qq-backend";
import { telegramBackend, type TelegramBotLink, type TelegramStatus } from "../../lib/telegram-backend";
import { wecomBackend, type WecomStatus } from "../../lib/wecom-backend";
import { wechatBackend, type WechatStatus } from "../../lib/wechat-backend";
import { channelMediaBackend, defaultChannelMediaCapability } from "../../lib/channel-media";
import type { ChannelMediaCapability } from "../../types";
import {
  ACTIVITY_LIMIT,
  aid,
  describeError,
  dingtalkChannelStatus,
  feishuChannelStatus,
  discordChannelStatus,
  qqChannelStatus,
  REMOTE_CHANNELS,
  telegramChannelStatus,
  wecomChannelStatus,
  wechatChannelStatus,
  type ChannelStatus,
  type RemoteActivity,
  type RemoteChannel,
} from "./shared";
import type { RemoteAssistantState } from "./state";

/** 宿主下发的媒体能力形状校验：两个字段都得是数组，否则按默认矩阵兜底。 */
function isChannelMediaCapability(value: unknown): value is ChannelMediaCapability {
  if (!value || typeof value !== "object") return false;
  const cap = value as Partial<ChannelMediaCapability>;
  return Array.isArray(cap.inbound) && Array.isArray(cap.outbound);
}

export interface StatusApi {
  statusOf(channel: RemoteChannel): ChannelStatus;
  connectedOf(channel: RemoteChannel): boolean;
  /** 微信通道是否已连接（既有调用点沿用此名）。 */
  connected: ComputedRef<boolean>;
  refreshStatus(): Promise<WechatStatus>;
  refreshDingTalkStatus(): Promise<DingTalkStatus>;
  refreshFeishuStatus(): Promise<FeishuStatus>;
  refreshTelegramStatus(): Promise<TelegramStatus>;
  refreshQqStatus(): Promise<QqStatus>;
  refreshDiscordStatus(): Promise<DiscordStatus>;
  refreshWecomStatus(): Promise<WecomStatus>;
  refreshTelegramBotLink(): Promise<TelegramBotLink | null>;
  /** 拉取各通道的媒体能力矩阵（宿主直出；取不到时保留默认矩阵）。 */
  refreshMediaCapabilities(): Promise<void>;
  recordActivity(entry: Omit<RemoteActivity, "id" | "at">): void;
}

export function createStatusSlice({ state }: { state: RemoteAssistantState }): StatusApi {
  /** 按通道取归一状态：界面只认这一份，不必为每条通道写分支。 */
  function statusOf(channel: RemoteChannel): ChannelStatus {
    if (channel === "wechat") return wechatChannelStatus(state.status.value);
    if (channel === "dingtalk") return dingtalkChannelStatus(state.dingtalkStatus.value);
    if (channel === "feishu") return feishuChannelStatus(state.feishuStatus.value);
    if (channel === "telegram") return telegramChannelStatus(state.telegramStatus.value);
    if (channel === "qq") return qqChannelStatus(state.qqStatus.value);
    if (channel === "discord") return discordChannelStatus(state.discordStatus.value);
    return wecomChannelStatus(state.wecomStatus.value);
  }

  /** 该通道是否在收消息（微信长轮询 / 钉钉长连接在跑）。 */
  function connectedOf(channel: RemoteChannel): boolean {
    return statusOf(channel).state === "connected";
  }

  /** 微信通道是否已连接（既有调用点沿用此名）。 */
  const connected = computed(() => connectedOf("wechat"));

  async function refreshStatus(): Promise<WechatStatus> {
    if (!state.available.value) return state.status.value;
    state.status.value = await wechatBackend.status();
    return state.status.value;
  }

  async function refreshDingTalkStatus(): Promise<DingTalkStatus> {
    if (!state.available.value) return state.dingtalkStatus.value;
    const next = await dingtalkBackend.status();
    // 宿主没给快照（旧版本 / 半截响应）时不覆盖现有状态：状态面只做展示，别让它打崩界面。
    if (next) state.dingtalkStatus.value = next;
    return state.dingtalkStatus.value;
  }

  async function refreshFeishuStatus(): Promise<FeishuStatus> {
    if (!state.available.value) return state.feishuStatus.value;
    const next = await feishuBackend.status();
    if (next) state.feishuStatus.value = next;
    return state.feishuStatus.value;
  }

  async function refreshTelegramStatus(): Promise<TelegramStatus> {
    if (!state.available.value) return state.telegramStatus.value;
    const next = await telegramBackend.status();
    if (next) state.telegramStatus.value = next;
    return state.telegramStatus.value;
  }

  async function refreshQqStatus(): Promise<QqStatus> {
    if (!state.available.value) return state.qqStatus.value;
    const next = await qqBackend.status();
    if (next) state.qqStatus.value = next;
    return state.qqStatus.value;
  }

  async function refreshDiscordStatus(): Promise<DiscordStatus> {
    if (!state.available.value) return state.discordStatus.value;
    const next = await discordBackend.status();
    if (next) state.discordStatus.value = next;
    return state.discordStatus.value;
  }

  async function refreshWecomStatus(): Promise<WecomStatus> {
    if (!state.available.value) return state.wecomStatus.value;
    const next = await wecomBackend.status();
    if (next) state.wecomStatus.value = next;
    return state.wecomStatus.value;
  }

  /**
   * 取机器人扫码链接（宿主 getMe）。
   *
   * 放在 status 切片：它是「当前通道长什么样」的一部分，且渲染端只读、可重复取。
   * 未配置 token / 网络失败时返回 null 并给出 detail——码摆不出来要说清为什么，
   * 而不是留一片空白。
   */
  async function refreshTelegramBotLink(): Promise<TelegramBotLink | null> {
    if (!state.available.value) return null;
    try {
      const link = await telegramBackend.botLink();
      state.telegramBotLink.value = { link, error: null };
      return link;
    } catch (error) {
      state.telegramBotLink.value = { link: null, error: describeError(error) };
      return null;
    }
  }

  /**
   * 拉取各通道的媒体能力矩阵。
   *
   * 宿主是协议事实的唯一来源；取不到（浏览器态、命令缺失、宿主半截响应）时保留默认矩阵 ——
   * 能力提示只影响「提前告知」，真正的拦截在宿主侧，兜底偏保守即可。
   */
  async function refreshMediaCapabilities(): Promise<void> {
    if (!state.available.value) return;
    try {
      const caps = await channelMediaBackend.capabilities();
      const next = {} as Record<RemoteChannel, ChannelMediaCapability>;
      for (const channel of REMOTE_CHANNELS) {
        const cap = caps[channel];
        next[channel] = isChannelMediaCapability(cap) ? cap : defaultChannelMediaCapability(channel);
      }
      state.mediaCapabilities.value = next;
    } catch (error) {
      console.warn("[remote-assistant] 媒体能力矩阵未取到，沿用默认", error);
    }
  }

  /** 活动流只保留最近一屏，越新的排越前。 */
  function recordActivity(entry: Omit<RemoteActivity, "id" | "at">): void {
    state.activity.value.unshift({ id: aid(), at: Date.now(), ...entry });
    if (state.activity.value.length > ACTIVITY_LIMIT) state.activity.value.length = ACTIVITY_LIMIT;
  }

  return {
    statusOf,
    connectedOf,
    connected,
    refreshStatus,
    refreshDingTalkStatus,
    refreshFeishuStatus,
    refreshTelegramStatus,
    refreshTelegramBotLink,
    refreshMediaCapabilities,
    refreshQqStatus,
    refreshDiscordStatus,
    refreshWecomStatus,
    recordActivity,
  };
}
