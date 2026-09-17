/**
 * remote-assistant store 装配入口（文件夹 facade）。
 *
 * 六片切片共享 `createRemoteAssistantState()` 造的同一份通道状态；切片间有环
 * （login → connect（确认后直接连）、connect → login（logout 作废扫码）），
 * 经 `api` 持有者 + 惰性 getter 在调用时才解析，装配顺序无关紧要。
 *
 * 公开 store API（returns 的键）与原 `stores/remote-assistant.ts` 完全一致，
 * 模块级类型 / 帮助函数（RemoteChannel、ChannelStatus、peerKey …）原样再导出。
 */
import { defineStore } from "pinia";
import {
  idleChannelStatus,
  wechatChannelStatus,
  feishuChannelStatus,
  discordChannelStatus,
  qqChannelStatus,
  telegramChannelStatus,
  wecomChannelStatus,
  dingtalkChannelStatus,
  peerKey,
  peerLabel,
  type RemoteChannel,
  type ChannelStatus,
  type RemoteActivity,
  type RemoteActivityKind,
  type RemotePeer,
  type WechatQrPhase,
  type WechatQrView,
  type FeishuRegisterView,
} from "./shared";
import type { StatusApi } from "./status";
import type { ConnectApi } from "./connect";
import type { LoginApi } from "./login";
import type { PeersApi } from "./peers";
import type { PipelineApi } from "./pipeline";
import type { LifecycleApi } from "./lifecycle";
import { createStatusSlice } from "./status";
import { createConnectSlice } from "./connect";
import { createLoginSlice } from "./login";
import { createPeersSlice } from "./peers";
import { createPipelineSlice } from "./pipeline";
import { createLifecycleSlice } from "./lifecycle";
import { createRemoteAssistantState } from "./state";

export type {
  RemoteChannel,
  ChannelStatus,
  RemoteActivity,
  RemoteActivityKind,
  RemotePeer,
  WechatQrPhase,
  WechatQrView,
  FeishuRegisterView,
};
export {
  idleChannelStatus,
  wechatChannelStatus,
  feishuChannelStatus,
  telegramChannelStatus,
  qqChannelStatus,
  discordChannelStatus,
  wecomChannelStatus,
  dingtalkChannelStatus,
  peerKey,
  peerLabel,
};

/** 新建联系人档案接口别名（peer 对象在此创建后再经 peerSessionId 绑定会话）。 */
export type { FeishuRegisterStart } from "./shared";

export const useRemoteAssistantStore = defineStore("remote-assistant", () => {
  const state = createRemoteAssistantState();

  /** 惰性 api 绑定：切片互相只经 getter 访问。 */
  const api: {
    status: StatusApi | null;
    connect: ConnectApi | null;
    login: LoginApi | null;
    peers: PeersApi | null;
    pipeline: PipelineApi | null;
    lifecycle: LifecycleApi | null;
  } = { status: null, connect: null, login: null, peers: null, pipeline: null, lifecycle: null };
  const getStatus = (): StatusApi => api.status as StatusApi;
  const getConnect = (): ConnectApi => api.connect as ConnectApi;
  const getLogin = (): LoginApi => api.login as LoginApi;
  const getPeers = (): PeersApi => api.peers as PeersApi;
  const getPipeline = (): PipelineApi => api.pipeline as PipelineApi;

  api.status = createStatusSlice({ state });
  api.connect = createConnectSlice({ state, getStatus, getLogin });
  api.login = createLoginSlice({ state, getStatus, getConnect });
  api.peers = createPeersSlice({ state });
  api.pipeline = createPipelineSlice({ state, getStatus, getPeers });
  api.lifecycle = createLifecycleSlice({ state, getStatus, getConnect, getPipeline });
  const status = api.status as StatusApi;
  const connect = api.connect as ConnectApi;
  const login = api.login as LoginApi;
  const peers = api.peers as PeersApi;
  const pipeline = api.pipeline as PipelineApi;
  const lifecycle = api.lifecycle as LifecycleApi;

  return {
    available: state.available,
    status: state.status,
    connected: status.connected,
    qr: state.qr,
    qrError: state.qrError,
    activity: state.activity,
    peers: state.peers,
    peerList: peers.peerList,
    peerById: peers.peerByKey,
    markPeerRead: peers.markPeerRead,
    sendFromDesktop: pipeline.sendFromDesktop,
    statusOf: status.statusOf,
    connectedOf: status.connectedOf,
    dingtalkStatus: state.dingtalkStatus,
    feishuStatus: state.feishuStatus,
    telegramStatus: state.telegramStatus,
    qqStatus: state.qqStatus,
    discordStatus: state.discordStatus,
    wecomStatus: state.wecomStatus,
    telegramBotLink: state.telegramBotLink,
    feishuRegister: state.feishuRegister,
    startFeishuRegistration: login.startFeishuRegistration,
    cancelFeishuRegistration: login.cancelFeishuRegistration,
    saveTelegramCredentials: connect.saveTelegramCredentials,
    connectTelegram: connect.connectTelegram,
    disconnectTelegram: connect.disconnectTelegram,
    clearTelegramCredentials: connect.clearTelegramCredentials,
    refreshTelegramStatus: status.refreshTelegramStatus,
    refreshQqStatus: status.refreshQqStatus,
    refreshWecomStatus: status.refreshWecomStatus,
    saveDiscordCredentials: connect.saveDiscordCredentials,
    connectDiscord: connect.connectDiscord,
    disconnectDiscord: connect.disconnectDiscord,
    clearDiscordCredentials: connect.clearDiscordCredentials,
    refreshDiscordStatus: status.refreshDiscordStatus,
    saveQqCredentials: connect.saveQqCredentials,
    connectQq: connect.connectQq,
    disconnectQq: connect.disconnectQq,
    clearQqCredentials: connect.clearQqCredentials,
    saveWecomCredentials: connect.saveWecomCredentials,
    connectWecom: connect.connectWecom,
    disconnectWecom: connect.disconnectWecom,
    clearWecomCredentials: connect.clearWecomCredentials,
    refreshTelegramBotLink: status.refreshTelegramBotLink,
    saveFeishuCredentials: connect.saveFeishuCredentials,
    connectFeishu: connect.connectFeishu,
    disconnectFeishu: connect.disconnectFeishu,
    clearFeishuCredentials: connect.clearFeishuCredentials,
    refreshFeishuStatus: status.refreshFeishuStatus,
    saveDingTalkCredentials: connect.saveDingTalkCredentials,
    connectDingTalk: connect.connectDingTalk,
    disconnectDingTalk: connect.disconnectDingTalk,
    clearDingTalkCredentials: connect.clearDingTalkCredentials,
    refreshDingTalkStatus: status.refreshDingTalkStatus,
    init: lifecycle.init,
    refreshStatus: status.refreshStatus,
    startLogin: login.startLogin,
    cancelLogin: login.cancelLogin,
    connect: connect.connect,
    disconnect: connect.disconnect,
    logout: connect.logout,
    applySenderPolicy: connect.applySenderPolicy,
  };
});
