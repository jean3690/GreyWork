/**
 * 连接切片：三条通道各自的连接 / 断开 / 清除凭证，退出登录，发送者策略切换。
 *
 * 依赖 status 切片（每次操作后刷新状态、记活动行）与 login 切片（logout 时作废扫码轮询），
 * 经 getStatus / getLogin 惰性访问；login 确认成功后也会调回本切片的 connect*。
 */
import { dingtalkBackend } from "../../lib/dingtalk-backend";
import { feishuBackend } from "../../lib/feishu-backend";
import { discordBackend } from "../../lib/discord-backend";
import { qqBackend } from "../../lib/qq-backend";
import { telegramBackend } from "../../lib/telegram-backend";
import { wecomBackend } from "../../lib/wecom-backend";
import { wechatBackend } from "../../lib/wechat-backend";
import { notify } from "../notice";
import { describeError, t, type RemoteChannel } from "./shared";
import type { RemoteAssistantState } from "./state";
import type { StatusApi } from "./status";
import type { LoginApi } from "./login";

export interface ConnectDeps {
  state: RemoteAssistantState;
  getStatus: () => StatusApi;
  getLogin: () => LoginApi;
}

export interface ConnectApi {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  logout(): Promise<void>;
  saveDingTalkCredentials(clientId: string, clientSecret: string): Promise<string | null>;
  connectDingTalk(): Promise<void>;
  disconnectDingTalk(): Promise<void>;
  clearDingTalkCredentials(): Promise<void>;
  saveFeishuCredentials(appId: string, appSecret: string): Promise<string | null>;
  connectFeishu(): Promise<void>;
  disconnectFeishu(): Promise<void>;
  clearFeishuCredentials(): Promise<void>;
  saveTelegramCredentials(token: string): Promise<string | null>;
  connectTelegram(): Promise<void>;
  disconnectTelegram(): Promise<void>;
  clearTelegramCredentials(): Promise<void>;
  saveQqCredentials(appId: string, appSecret: string): Promise<string | null>;
  connectQq(): Promise<void>;
  disconnectQq(): Promise<void>;
  clearQqCredentials(): Promise<void>;
  saveDiscordCredentials(token: string): Promise<string | null>;
  connectDiscord(): Promise<void>;
  disconnectDiscord(): Promise<void>;
  clearDiscordCredentials(): Promise<void>;
  saveWecomCredentials(botId: string, secret: string): Promise<string | null>;
  connectWecom(): Promise<void>;
  disconnectWecom(): Promise<void>;
  clearWecomCredentials(): Promise<void>;
  applySenderPolicy(channel: RemoteChannel): Promise<void>;
}

export function createConnectSlice({ state, getStatus, getLogin }: ConnectDeps): ConnectApi {
  const settings = state.settings;

  /* ===== 微信 · 连接 / 断开 / 退出 ===== */

  async function connect(): Promise<void> {
    if (!state.available.value || !state.status.value.loggedIn) return;
    try {
      await wechatBackend.connect(settings.remoteAssist.channels.wechat.allowOtherSenders);
      await getStatus().refreshStatus();
    } catch (error) {
      notify({ kind: "error", key: "wechat-connect", title: t("remoteAssist.wechat.connectFailed"), detail: describeError(error) });
      await getStatus()
        .refreshStatus()
        .catch(() => undefined);
    }
  }

  async function disconnect(): Promise<void> {
    if (!state.available.value) return;
    await wechatBackend.disconnect();
    await getStatus().refreshStatus();
  }

  async function logout(): Promise<void> {
    if (!state.available.value) return;
    getLogin().cancelLogin();
    await wechatBackend.logout();
    await getStatus().refreshStatus();
    getStatus().recordActivity({
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
    if (!state.available.value) return t("remoteAssist.wechat.desktopOnly");
    try {
      state.dingtalkStatus.value = await dingtalkBackend.saveCredentials(clientId.trim(), clientSecret.trim());
      return null;
    } catch (error) {
      return describeError(error);
    }
  }

  async function connectDingTalk(): Promise<void> {
    if (!state.available.value || !state.dingtalkStatus.value.configured) return;
    try {
      await dingtalkBackend.connect(settings.remoteAssist.channels.dingtalk.allowOtherSenders);
      await getStatus().refreshDingTalkStatus();
    } catch (error) {
      notify({ kind: "error", key: "dingtalk-connect", title: t("remoteAssist.dingtalk.connectFailed"), detail: describeError(error) });
      await getStatus()
        .refreshDingTalkStatus()
        .catch(() => undefined);
    }
  }

  async function disconnectDingTalk(): Promise<void> {
    if (!state.available.value) return;
    await dingtalkBackend.disconnect();
    await getStatus().refreshDingTalkStatus();
  }

  /** 清除凭证（相当于退出登录）：长连接停止，凭证与联系人回发凭据一并删除。 */
  async function clearDingTalkCredentials(): Promise<void> {
    if (!state.available.value) return;
    state.dingtalkStatus.value = await dingtalkBackend.clearCredentials();
    getStatus().recordActivity({
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
    if (!state.available.value) return t("remoteAssist.wechat.desktopOnly");
    try {
      state.feishuStatus.value = await feishuBackend.saveCredentials(appId.trim(), appSecret.trim());
      return null;
    } catch (error) {
      return describeError(error);
    }
  }

  async function connectFeishu(): Promise<void> {
    if (!state.available.value || !state.feishuStatus.value.configured) return;
    try {
      await feishuBackend.connect(settings.remoteAssist.channels.feishu.allowOtherSenders);
      await getStatus().refreshFeishuStatus();
    } catch (error) {
      notify({ kind: "error", key: "feishu-connect", title: t("remoteAssist.feishu.connectFailed"), detail: describeError(error) });
      await getStatus()
        .refreshFeishuStatus()
        .catch(() => undefined);
    }
  }

  async function disconnectFeishu(): Promise<void> {
    if (!state.available.value) return;
    await feishuBackend.disconnect();
    await getStatus().refreshFeishuStatus();
  }

  /** 清除凭证（相当于退出登录）：长连接停止，凭证与联系人档案一并删除。 */
  async function clearFeishuCredentials(): Promise<void> {
    if (!state.available.value) return;
    state.feishuStatus.value = await feishuBackend.clearCredentials();
    getStatus().recordActivity({
      direction: "in",
      peer: t("remoteAssist.channels.feishu"),
      channel: "feishu",
      text: t("remoteAssist.feishu.cleared"),
      kind: "system",
    });
  }

  /* ===== Telegram · 凭证与连接 ===== */

  /** 保存 bot token（宿主校验 `数字:密钥` 形状）。 */
  async function saveTelegramCredentials(token: string): Promise<string | null> {
    if (!state.available.value) return t("remoteAssist.wechat.desktopOnly");
    try {
      state.telegramStatus.value = await telegramBackend.saveCredentials(token.trim());
      return null;
    } catch (error) {
      return describeError(error);
    }
  }

  async function connectTelegram(): Promise<void> {
    if (!state.available.value || !state.telegramStatus.value.configured) return;
    try {
      await telegramBackend.connect(settings.remoteAssist.channels.telegram.allowOtherSenders);
      await getStatus().refreshTelegramStatus();
    } catch (error) {
      notify({ kind: "error", key: "telegram-connect", title: t("remoteAssist.telegram.connectFailed"), detail: describeError(error) });
      await getStatus()
        .refreshTelegramStatus()
        .catch(() => undefined);
    }
  }

  async function disconnectTelegram(): Promise<void> {
    if (!state.available.value) return;
    await telegramBackend.disconnect();
    await getStatus().refreshTelegramStatus();
  }

  /** 清除 token（相当于退出登录）：长轮询停止，联系人档案一并删除。 */
  async function clearTelegramCredentials(): Promise<void> {
    if (!state.available.value) return;
    state.telegramStatus.value = await telegramBackend.clearCredentials();
    getStatus().recordActivity({
      direction: "in",
      peer: t("remoteAssist.channels.telegram"),
      channel: "telegram",
      text: t("remoteAssist.telegram.cleared"),
      kind: "system",
    });
  }

  /* ===== QQ · 凭证与连接 ===== */

  /** 保存 AppID / AppSecret（AppSecret 留空表示沿用已存密钥）。 */
  async function saveQqCredentials(appId: string, appSecret: string): Promise<string | null> {
    if (!state.available.value) return t("remoteAssist.wechat.desktopOnly");
    try {
      state.qqStatus.value = await qqBackend.saveCredentials(appId.trim(), appSecret.trim());
      return null;
    } catch (error) {
      return describeError(error);
    }
  }

  async function connectQq(): Promise<void> {
    if (!state.available.value || !state.qqStatus.value.configured) return;
    try {
      await qqBackend.connect(settings.remoteAssist.channels.qq.allowOtherSenders);
      await getStatus().refreshQqStatus();
    } catch (error) {
      notify({ kind: "error", key: "qq-connect", title: t("remoteAssist.qq.connectFailed"), detail: describeError(error) });
      await getStatus()
        .refreshQqStatus()
        .catch(() => undefined);
    }
  }

  async function disconnectQq(): Promise<void> {
    if (!state.available.value) return;
    await qqBackend.disconnect();
    await getStatus().refreshQqStatus();
  }

  /** 清除凭证（相当于退出登录）：网关停止，联系人凭据一并删除。 */
  async function clearQqCredentials(): Promise<void> {
    if (!state.available.value) return;
    state.qqStatus.value = await qqBackend.clearCredentials();
    getStatus().recordActivity({
      direction: "in",
      peer: t("remoteAssist.channels.qq"),
      channel: "qq",
      text: t("remoteAssist.qq.cleared"),
      kind: "system",
    });
  }

  /* ===== Discord · 凭证与连接 ===== */

  /** 保存 bot token（宿主先探针校验，形状不对或 401 都会在这里报错）。 */
  async function saveDiscordCredentials(token: string): Promise<string | null> {
    if (!state.available.value) return t("remoteAssist.wechat.desktopOnly");
    try {
      state.discordStatus.value = await discordBackend.saveCredentials(token.trim());
      return null;
    } catch (error) {
      return describeError(error);
    }
  }

  async function connectDiscord(): Promise<void> {
    if (!state.available.value || !state.discordStatus.value.configured) return;
    try {
      await discordBackend.connect(settings.remoteAssist.channels.discord.allowOtherSenders);
      await getStatus().refreshDiscordStatus();
    } catch (error) {
      notify({ kind: "error", key: "discord-connect", title: t("remoteAssist.discord.connectFailed"), detail: describeError(error) });
      await getStatus()
        .refreshDiscordStatus()
        .catch(() => undefined);
    }
  }

  async function disconnectDiscord(): Promise<void> {
    if (!state.available.value) return;
    await discordBackend.disconnect();
    await getStatus().refreshDiscordStatus();
  }

  /** 清除 token（相当于退出登录）：网关停止，私聊档案一并删除。 */
  async function clearDiscordCredentials(): Promise<void> {
    if (!state.available.value) return;
    state.discordStatus.value = await discordBackend.clearCredentials();
    getStatus().recordActivity({
      direction: "in",
      peer: t("remoteAssist.channels.discord"),
      channel: "discord",
      text: t("remoteAssist.discord.cleared"),
      kind: "system",
    });
  }

  /* ===== 企业微信 · 凭证与连接 ===== */

  /** 保存 BotID / Secret（Secret 留空表示沿用已存密钥）。 */
  async function saveWecomCredentials(botId: string, secret: string): Promise<string | null> {
    if (!state.available.value) return t("remoteAssist.wechat.desktopOnly");
    try {
      state.wecomStatus.value = await wecomBackend.saveCredentials(botId.trim(), secret.trim());
      return null;
    } catch (error) {
      return describeError(error);
    }
  }

  async function connectWecom(): Promise<void> {
    if (!state.available.value || !state.wecomStatus.value.configured) return;
    try {
      await wecomBackend.connect(settings.remoteAssist.channels.wecom.allowOtherSenders);
      await getStatus().refreshWecomStatus();
    } catch (error) {
      notify({ kind: "error", key: "wecom-connect", title: t("remoteAssist.wecom.connectFailed"), detail: describeError(error) });
      await getStatus()
        .refreshWecomStatus()
        .catch(() => undefined);
    }
  }

  async function disconnectWecom(): Promise<void> {
    if (!state.available.value) return;
    await wecomBackend.disconnect();
    await getStatus().refreshWecomStatus();
  }

  /** 清除凭证（相当于退出登录）：长连接停止，联系人凭据一并删除。 */
  async function clearWecomCredentials(): Promise<void> {
    if (!state.available.value) return;
    state.wecomStatus.value = await wecomBackend.clearCredentials();
    getStatus().recordActivity({
      direction: "in",
      peer: t("remoteAssist.channels.wecom"),
      channel: "wecom",
      text: t("remoteAssist.wecom.cleared"),
      kind: "system",
    });
  }

  /** 发送者策略变更后调用：该通道已连接则重连一次，让宿主换用新策略。 */
  async function applySenderPolicy(channel: RemoteChannel): Promise<void> {
    if (!state.available.value) return;
    const stateNow = getStatus().statusOf(channel).state;
    if (stateNow !== "connected" && stateNow !== "connecting") return;
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
    if (channel === "feishu") {
      await feishuBackend.disconnect();
      await connectFeishu();
      return;
    }
    if (channel === "telegram") {
      await telegramBackend.disconnect();
      await connectTelegram();
      return;
    }
    if (channel === "qq") {
      await qqBackend.disconnect();
      await connectQq();
      return;
    }
    if (channel === "discord") {
      await discordBackend.disconnect();
      await connectDiscord();
      return;
    }
    await wecomBackend.disconnect();
    await connectWecom();
  }

  return {
    connect,
    disconnect,
    logout,
    saveDingTalkCredentials,
    connectDingTalk,
    disconnectDingTalk,
    clearDingTalkCredentials,
    saveFeishuCredentials,
    connectFeishu,
    disconnectFeishu,
    clearFeishuCredentials,
    saveTelegramCredentials,
    connectTelegram,
    disconnectTelegram,
    clearTelegramCredentials,
    saveQqCredentials,
    connectQq,
    disconnectQq,
    clearQqCredentials,
    saveDiscordCredentials,
    connectDiscord,
    disconnectDiscord,
    clearDiscordCredentials,
    saveWecomCredentials,
    connectWecom,
    disconnectWecom,
    clearWecomCredentials,
    applySenderPolicy,
  };
}
