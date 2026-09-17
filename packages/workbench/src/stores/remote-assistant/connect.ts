/**
 * 连接切片：三条通道各自的连接 / 断开 / 清除凭证，退出登录，发送者策略切换。
 *
 * 依赖 status 切片（每次操作后刷新状态、记活动行）与 login 切片（logout 时作废扫码轮询），
 * 经 getStatus / getLogin 惰性访问；login 确认成功后也会调回本切片的 connect*。
 */
import { dingtalkBackend } from "../../lib/dingtalk-backend";
import { feishuBackend } from "../../lib/feishu-backend";
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
    await feishuBackend.disconnect();
    await connectFeishu();
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
    applySenderPolicy,
  };
}
