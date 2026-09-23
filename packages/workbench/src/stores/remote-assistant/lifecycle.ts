/**
 * 生命周期切片：注册六条通道的状态 / 入站事件监听，并按各自设置自动连接。
 * Shell 挂载时只调 init() 一次。
 *
 * 依赖 status / connect / pipeline 切片（经 getStatus / getConnect / getPipeline
 * 惰性访问），注册顺序保持既定的「微信 → 钉钉 → 飞书 → Telegram → QQ → 企业微信」。
 */
import { wechatBackend } from "../../lib/wechat-backend";
import { dingtalkBackend } from "../../lib/dingtalk-backend";
import { feishuBackend } from "../../lib/feishu-backend";
import { discordBackend } from "../../lib/discord-backend";
import { qqBackend } from "../../lib/qq-backend";
import { telegramBackend } from "../../lib/telegram-backend";
import { wecomBackend } from "../../lib/wecom-backend";
import { t } from "./shared";
import { ensureRemoteWorkspace, ensureRemoteWorkspaceFolder } from "../../lib/remote-workspace";
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

    await telegramBackend.onState((next) => {
      const wasConnected = state.telegramStatus.value.state === "connected";
      state.telegramStatus.value = next;
      if (wasConnected && next.state !== "connected" && next.detail) {
        getStatus().recordActivity({
          direction: "in",
          peer: t("remoteAssist.channels.telegram"),
          channel: "telegram",
          text: next.detail,
          kind: "error",
        });
      }
    });
    await telegramBackend.onInbound(getPipeline().onTelegramInbound);

    await qqBackend.onState((next) => {
      const wasConnected = state.qqStatus.value.state === "connected";
      state.qqStatus.value = next;
      if (wasConnected && next.state !== "connected" && next.detail) {
        getStatus().recordActivity({
          direction: "in",
          peer: t("remoteAssist.channels.qq"),
          channel: "qq",
          text: next.detail,
          kind: "error",
        });
      }
    });
    await qqBackend.onInbound(getPipeline().onQqInbound);

    await discordBackend.onState((next) => {
      const wasConnected = state.discordStatus.value.state === "connected";
      state.discordStatus.value = next;
      if (wasConnected && next.state !== "connected" && next.detail) {
        getStatus().recordActivity({
          direction: "in",
          peer: t("remoteAssist.channels.discord"),
          channel: "discord",
          text: next.detail,
          kind: "error",
        });
      }
    });
    await discordBackend.onInbound(getPipeline().onDiscordInbound);

    await wecomBackend.onState((next) => {
      const wasConnected = state.wecomStatus.value.state === "connected";
      state.wecomStatus.value = next;
      if (wasConnected && next.state !== "connected" && next.detail) {
        getStatus().recordActivity({
          direction: "in",
          peer: t("remoteAssist.channels.wecom"),
          channel: "wecom",
          text: next.detail,
          kind: "error",
        });
      }
    });
    await wecomBackend.onInbound(getPipeline().onWecomInbound);
  }

  /** 幂等启动：注册六条通道的事件、拉状态、按各自设置自动连接（由 Shell 挂载时调用）。 */
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
      await getStatus()
        .refreshTelegramStatus()
        .catch(() => undefined);
      await getStatus()
        .refreshQqStatus()
        .catch(() => undefined);
      await getStatus()
        .refreshDiscordStatus()
        .catch(() => undefined);
      await getStatus()
        .refreshWecomStatus()
        .catch(() => undefined);
      // 媒体能力矩阵：宿主直出，取不到就沿用默认（能力提示只是提前告知，真拦截在宿主侧）。
      await getStatus().refreshMediaCapabilities();
    } catch (error) {
      console.error("[remote-assistant] 初始化失败", error);
      return;
    }

    const anyReady =
      state.status.value.loggedIn ||
      state.dingtalkStatus.value.configured ||
      state.feishuStatus.value.configured ||
      state.telegramStatus.value.configured ||
      state.qqStatus.value.configured ||
      state.discordStatus.value.configured ||
      state.wecomStatus.value.configured;
    if (anyReady) {
      ensureRemoteWorkspace(state.workspace);
      await ensureRemoteWorkspaceFolder(state.workspace).catch((error: unknown) => {
        console.warn("[remote-assistant] 远程工作区文件夹未就绪", error);
      });
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
    if (
      settings.remoteAssist.channels.telegram.autoConnect &&
      state.telegramStatus.value.configured &&
      state.telegramStatus.value.state !== "connected"
    ) {
      await getConnect().connectTelegram();
    }
    if (settings.remoteAssist.channels.qq.autoConnect && state.qqStatus.value.configured && state.qqStatus.value.state !== "connected") {
      await getConnect().connectQq();
    }
    if (
      settings.remoteAssist.channels.discord.autoConnect &&
      state.discordStatus.value.configured &&
      state.discordStatus.value.state !== "connected"
    ) {
      await getConnect().connectDiscord();
    }
    if (
      settings.remoteAssist.channels.wecom.autoConnect &&
      state.wecomStatus.value.configured &&
      state.wecomStatus.value.state !== "connected"
    ) {
      await getConnect().connectWecom();
    }
  }

  return { init };
}
