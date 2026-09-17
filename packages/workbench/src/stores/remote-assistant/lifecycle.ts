/**
 * 生命周期切片：注册三条通道的状态 / 入站事件监听，并按各自设置自动连接。
 * Shell 挂载时只调 init() 一次。
 *
 * 依赖 status / connect / pipeline 切片（经 getStatus / getConnect / getPipeline
 * 惰性访问），注册顺序与手性保持原实现的既定顺序（微信 → 钉钉 → 飞书）。
 */
import { wechatBackend } from "../../lib/wechat-backend";
import { dingtalkBackend } from "../../lib/dingtalk-backend";
import { feishuBackend } from "../../lib/feishu-backend";
import { t } from "./shared";
import type { RemoteAssistantState } from "./state";
import type { StatusApi } from "./status";
import type { ConnectApi } from "./connect";
import type { PipelineApi } from "./pipeline";

export interface LifecycleDeps {
  state: RemoteAssistantState;
  getStatus: () => StatusApi;
  getConnect: () => ConnectApi;
  getPipeline: () => PipelineApi;
}

export interface LifecycleApi {
  init(): Promise<void>;
}

export function createLifecycleSlice({ state, getStatus, getConnect, getPipeline }: LifecycleDeps): LifecycleApi {
  const settings = state.settings;

  let listenersAttached = false;

  async function attachListeners(): Promise<void> {
    if (listenersAttached) return;
    listenersAttached = true;

    await wechatBackend.onState((next) => {
      const wasConnected = state.status.value.state === "connected";
      state.status.value = next;
      if (wasConnected && next.state !== "connected" && next.detail) {
        getStatus().recordActivity({
          direction: "in",
          peer: t("remoteAssist.wechat.botName"),
          channel: "wechat",
          text: next.detail,
          kind: "error",
        });
      }
    });
    await wechatBackend.onInbound(getPipeline().onWechatInbound);

    await dingtalkBackend.onState((next) => {
      const wasConnected = state.dingtalkStatus.value.state === "connected";
      state.dingtalkStatus.value = next;
      if (wasConnected && next.state !== "connected" && next.detail) {
        getStatus().recordActivity({
          direction: "in",
          peer: t("remoteAssist.channels.dingtalk"),
          channel: "dingtalk",
          text: next.detail,
          kind: "error",
        });
      }
    });
    await dingtalkBackend.onInbound(getPipeline().onDingTalkInbound);

    await feishuBackend.onState((next) => {
      const wasConnected = state.feishuStatus.value.state === "connected";
      state.feishuStatus.value = next;
      if (wasConnected && next.state !== "connected" && next.detail) {
        getStatus().recordActivity({
          direction: "in",
          peer: t("remoteAssist.channels.feishu"),
          channel: "feishu",
          text: next.detail,
          kind: "error",
        });
      }
    });
    await feishuBackend.onInbound(getPipeline().onFeishuInbound);
  }

  /** 幂等启动：注册三条通道的事件、拉状态、按各自设置自动连接（由 Shell 挂载时调用）。 */
  async function init(): Promise<void> {
    if (state.initialized.value) return;
    state.initialized.value = true;
    state.available.value = wechatBackend.supported();
    if (!state.available.value) return;
    try {
      await attachListeners();
      await getStatus().refreshStatus();
      // 钉钉同样只有桌面端有宿主命令；浏览器态跳过（保持状态为初始值）。
      await getStatus()
        .refreshDingTalkStatus()
        .catch(() => undefined);
      await getStatus()
        .refreshFeishuStatus()
        .catch(() => undefined);
    } catch (error) {
      console.error("[remote-assistant] 初始化失败", error);
      return;
    }
    if (settings.remoteAssist.channels.wechat.autoConnect && state.status.value.loggedIn && state.status.value.state !== "connected") {
      await getConnect().connect();
    }
    if (
      settings.remoteAssist.channels.dingtalk.autoConnect &&
      state.dingtalkStatus.value.configured &&
      state.dingtalkStatus.value.state !== "connected"
    ) {
      await getConnect().connectDingTalk();
    }
    if (
      settings.remoteAssist.channels.feishu.autoConnect &&
      state.feishuStatus.value.configured &&
      state.feishuStatus.value.state !== "connected"
    ) {
      await getConnect().connectFeishu();
    }
  }

  return { init };
}
