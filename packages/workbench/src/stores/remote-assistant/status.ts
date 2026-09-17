/**
 * 通道状态切片：把微信 / 钉钉 / 飞书三条宿主管道的原始状态归一成一份界面形状，
 * 并提供刷新入口与活动流记录。纯函数切片，不依赖其他切片。
 */
import { computed, type ComputedRef } from "vue";
import type { DingTalkStatus } from "../../lib/dingtalk-backend";
import { dingtalkBackend } from "../../lib/dingtalk-backend";
import type { FeishuStatus } from "../../lib/feishu-backend";
import { feishuBackend } from "../../lib/feishu-backend";
import { wechatBackend, type WechatStatus } from "../../lib/wechat-backend";
import {
  ACTIVITY_LIMIT,
  aid,
  dingtalkChannelStatus,
  feishuChannelStatus,
  wechatChannelStatus,
  type ChannelStatus,
  type RemoteActivity,
  type RemoteChannel,
} from "./shared";
import type { RemoteAssistantState } from "./state";

export interface StatusApi {
  statusOf(channel: RemoteChannel): ChannelStatus;
  connectedOf(channel: RemoteChannel): boolean;
  /** 微信通道是否已连接（既有调用点沿用此名）。 */
  connected: ComputedRef<boolean>;
  refreshStatus(): Promise<WechatStatus>;
  refreshDingTalkStatus(): Promise<DingTalkStatus>;
  refreshFeishuStatus(): Promise<FeishuStatus>;
  recordActivity(entry: Omit<RemoteActivity, "id" | "at">): void;
}

export function createStatusSlice({ state }: { state: RemoteAssistantState }): StatusApi {
  /** 按通道取归一状态：界面只认这一份，不必为每条通道写分支。 */
  function statusOf(channel: RemoteChannel): ChannelStatus {
    if (channel === "wechat") return wechatChannelStatus(state.status.value);
    if (channel === "dingtalk") return dingtalkChannelStatus(state.dingtalkStatus.value);
    return feishuChannelStatus(state.feishuStatus.value);
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
    recordActivity,
  };
}
