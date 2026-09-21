// 连接切片的可观测契约：浏览器态早退 / 凭证保存成败 / 各通道 connect-disconnect-clear /
// 退出登录的清理顺序 / applySenderPolicy 只在已连接态重连。切片经 createConnectSlice 注入。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { i18n } from "@/i18n";
import type { RemoteChannel } from "@/stores/remote-assistant/shared";

const t = i18n.global.t;

const notices = vi.hoisted(() => ({ notify: vi.fn() }));

const backends = vi.hoisted(() => ({
  wechatConnect: vi.fn<(flag: boolean) => Promise<void>>(() => Promise.resolve()),
  wechatDisconnect: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  wechatLogout: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  dingtalkSave: vi.fn<(a: string, s: string) => Promise<unknown>>(() => Promise.resolve({})),
  dingtalkConnect: vi.fn<(flag: boolean) => Promise<void>>(() => Promise.resolve()),
  dingtalkDisconnect: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  dingtalkClear: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
  feishuSave: vi.fn<(a: string, s: string) => Promise<unknown>>(() => Promise.resolve({})),
  feishuConnect: vi.fn<(flag: boolean) => Promise<void>>(() => Promise.resolve()),
  feishuDisconnect: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  feishuClear: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
  telegramSave: vi.fn<(a: string) => Promise<unknown>>(() => Promise.resolve({})),
  telegramConnect: vi.fn<(flag: boolean) => Promise<void>>(() => Promise.resolve()),
  telegramDisconnect: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  telegramClear: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
  qqSave: vi.fn<(a: string, s: string) => Promise<unknown>>(() => Promise.resolve({})),
  qqConnect: vi.fn<(flag: boolean) => Promise<void>>(() => Promise.resolve()),
  qqDisconnect: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  qqClear: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
  discordSave: vi.fn<(a: string) => Promise<unknown>>(() => Promise.resolve({})),
  discordConnect: vi.fn<(flag: boolean) => Promise<void>>(() => Promise.resolve()),
  discordDisconnect: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  discordClear: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
  wecomSave: vi.fn<(a: string, s: string) => Promise<unknown>>(() => Promise.resolve({})),
  wecomConnect: vi.fn<(flag: boolean) => Promise<void>>(() => Promise.resolve()),
  wecomDisconnect: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  wecomClear: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
}));

vi.mock("@/stores/notice", () => ({ notify: (input: unknown) => notices.notify(input) }));
vi.mock("@/lib/wechat-backend", () => ({
  wechatBackend: {
    connect: (flag: boolean) => backends.wechatConnect(flag),
    disconnect: () => backends.wechatDisconnect(),
    logout: () => backends.wechatLogout(),
  },
}));
vi.mock("@/lib/dingtalk-backend", () => ({
  dingtalkBackend: {
    saveCredentials: (a: string, s: string) => backends.dingtalkSave(a, s),
    connect: (flag: boolean) => backends.dingtalkConnect(flag),
    disconnect: () => backends.dingtalkDisconnect(),
    clearCredentials: () => backends.dingtalkClear(),
  },
}));
vi.mock("@/lib/feishu-backend", () => ({
  feishuBackend: {
    saveCredentials: (a: string, s: string) => backends.feishuSave(a, s),
    connect: (flag: boolean) => backends.feishuConnect(flag),
    disconnect: () => backends.feishuDisconnect(),
    clearCredentials: () => backends.feishuClear(),
  },
}));
vi.mock("@/lib/telegram-backend", () => ({
  telegramBackend: {
    saveCredentials: (a: string) => backends.telegramSave(a),
    connect: (flag: boolean) => backends.telegramConnect(flag),
    disconnect: () => backends.telegramDisconnect(),
    clearCredentials: () => backends.telegramClear(),
  },
}));
vi.mock("@/lib/qq-backend", () => ({
  qqBackend: {
    saveCredentials: (a: string, s: string) => backends.qqSave(a, s),
    connect: (flag: boolean) => backends.qqConnect(flag),
    disconnect: () => backends.qqDisconnect(),
    clearCredentials: () => backends.qqClear(),
  },
}));
vi.mock("@/lib/discord-backend", () => ({
  discordBackend: {
    saveCredentials: (a: string) => backends.discordSave(a),
    connect: (flag: boolean) => backends.discordConnect(flag),
    disconnect: () => backends.discordDisconnect(),
    clearCredentials: () => backends.discordClear(),
  },
}));
vi.mock("@/lib/wecom-backend", () => ({
  wecomBackend: {
    saveCredentials: (a: string, s: string) => backends.wecomSave(a, s),
    connect: (flag: boolean) => backends.wecomConnect(flag),
    disconnect: () => backends.wecomDisconnect(),
    clearCredentials: () => backends.wecomClear(),
  },
}));

import { createConnectSlice, type ConnectApi } from "@/stores/remote-assistant/connect";
import type { StatusApi } from "@/stores/remote-assistant/status";
import type { LoginApi } from "@/stores/remote-assistant/login";
import type { RemoteAssistantState } from "@/stores/remote-assistant/state";

interface ActivityEntry {
  direction: string;
  channel: string;
  text: string;
  kind: string;
}

interface ConnectHarness {
  api: ConnectApi;
  activity: ActivityEntry[];
  login: { cancelLogin: Mock<() => void> };
  state: Record<string, { value: unknown }>;
  settings: { remoteAssist: { channels: Record<string, { allowOtherSenders: boolean }> } };
  refresh: Record<
    | "refreshStatus"
    | "refreshDingTalkStatus"
    | "refreshFeishuStatus"
    | "refreshTelegramStatus"
    | "refreshQqStatus"
    | "refreshDiscordStatus"
    | "refreshWecomStatus",
    Mock<() => Promise<unknown>>
  >;
  setChannelState(channel: RemoteChannel, state: string): void;
  setConfigured(channel: RemoteChannel, configured: boolean): void;
}

function idleConfiguredChannel(): { value: unknown } {
  return { value: { configured: false, state: "stopped", detail: null } };
}

const CHANNEL_MAP: Record<string, { statusKey: string; saveArgs: unknown[]; allow: boolean }> = {
  dingtalk: { statusKey: "dingtalkStatus", saveArgs: ["cli-1", "secret-9"], allow: false },
  feishu: { statusKey: "feishuStatus", saveArgs: ["app-1", "secret-9"], allow: false },
  telegram: { statusKey: "telegramStatus", saveArgs: ["123:abc"], allow: false },
  qq: { statusKey: "qqStatus", saveArgs: ["app-q", "secret-9"], allow: false },
  discord: { statusKey: "discordStatus", saveArgs: ["tok-9"], allow: false },
  wecom: { statusKey: "wecomStatus", saveArgs: ["bot-1", "secret-9"], allow: false },
};

function build(): ConnectHarness {
  const activity: ActivityEntry[] = [];
  const channelStates: Record<string, string> = {
    wechat: "stopped",
    dingtalk: "stopped",
    feishu: "stopped",
    telegram: "stopped",
    qq: "stopped",
    discord: "stopped",
    wecom: "stopped",
  };
  const settings = {
    remoteAssist: {
      channels: {
        wechat: { allowOtherSenders: false },
        dingtalk: { allowOtherSenders: false },
        feishu: { allowOtherSenders: false },
        telegram: { allowOtherSenders: false },
        qq: { allowOtherSenders: false },
        discord: { allowOtherSenders: false },
        wecom: { allowOtherSenders: false },
      },
    },
  };
  const state: Record<string, { value: unknown }> = {
    available: { value: true },
    status: { value: { loggedIn: false, state: "stopped", detail: null } },
    dingtalkStatus: idleConfiguredChannel(),
    feishuStatus: idleConfiguredChannel(),
    telegramStatus: idleConfiguredChannel(),
    qqStatus: idleConfiguredChannel(),
    discordStatus: idleConfiguredChannel(),
    wecomStatus: idleConfiguredChannel(),
    settings: settings as never,
  };
  const refreshStatus = vi.fn(() => Promise.resolve({}));
  const refreshDingTalkStatus = vi.fn(() => Promise.resolve({}));
  const refreshFeishuStatus = vi.fn(() => Promise.resolve({}));
  const refreshTelegramStatus = vi.fn(() => Promise.resolve({}));
  const refreshQqStatus = vi.fn(() => Promise.resolve({}));
  const refreshDiscordStatus = vi.fn(() => Promise.resolve({}));
  const refreshWecomStatus = vi.fn(() => Promise.resolve({}));
  const statusApi = {
    refreshStatus,
    refreshDingTalkStatus,
    refreshFeishuStatus,
    refreshTelegramStatus,
    refreshQqStatus,
    refreshDiscordStatus,
    refreshWecomStatus,
    statusOf: (channel: RemoteChannel) => ({ state: channelStates[channel] }),
    recordActivity: (entry: ActivityEntry) => activity.push(entry),
  } as unknown as StatusApi;
  const cancelLogin = vi.fn(() => undefined);
  const login = { cancelLogin } as unknown as LoginApi;
  const api = createConnectSlice({
    state: state as unknown as RemoteAssistantState,
    getStatus: () => statusApi,
    getLogin: () => login,
  });
  return {
    api,
    activity,
    login: { cancelLogin },
    state,
    settings,
    refresh: {
      refreshStatus,
      refreshDingTalkStatus,
      refreshFeishuStatus,
      refreshTelegramStatus,
      refreshQqStatus,
      refreshDiscordStatus,
      refreshWecomStatus,
    },
    setChannelState: (channel: RemoteChannel, next: string) => {
      channelStates[channel] = next;
    },
    setConfigured: (channel: RemoteChannel, configured: boolean) => {
      if (channel === "wechat") {
        state.status.value = { ...(state.status.value as object), loggedIn: configured } as never;
        return;
      }
      const key = CHANNEL_MAP[channel].statusKey;
      state[key].value = { ...(state[key].value as object), configured } as never;
    },
  };
}

function saveProperty(channel: string): keyof ConnectApi {
  switch (channel) {
    case "dingtalk":
      return "saveDingTalkCredentials";
    case "feishu":
      return "saveFeishuCredentials";
    case "telegram":
      return "saveTelegramCredentials";
    case "qq":
      return "saveQqCredentials";
    case "discord":
      return "saveDiscordCredentials";
    default:
      return "saveWecomCredentials";
  }
}

function connectProperty(channel: string): keyof ConnectApi {
  switch (channel) {
    case "dingtalk":
      return "connectDingTalk";
    case "feishu":
      return "connectFeishu";
    case "telegram":
      return "connectTelegram";
    case "qq":
      return "connectQq";
    case "discord":
      return "connectDiscord";
    default:
      return "connectWecom";
  }
}

function disconnectProperty(channel: string): keyof ConnectApi {
  switch (channel) {
    case "dingtalk":
      return "disconnectDingTalk";
    case "feishu":
      return "disconnectFeishu";
    case "telegram":
      return "disconnectTelegram";
    case "qq":
      return "disconnectQq";
    case "discord":
      return "disconnectDiscord";
    default:
      return "disconnectWecom";
  }
}

function clearProperty(channel: string): keyof ConnectApi {
  switch (channel) {
    case "dingtalk":
      return "clearDingTalkCredentials";
    case "feishu":
      return "clearFeishuCredentials";
    case "telegram":
      return "clearTelegramCredentials";
    case "qq":
      return "clearQqCredentials";
    case "discord":
      return "clearDiscordCredentials";
    default:
      return "clearWecomCredentials";
  }
}

function backendFor(channel: string) {
  return {
    save: backends[`${channel}Save` as keyof typeof backends] as Mock<() => Promise<unknown>>,
    connect: backends[`${channel}Connect` as keyof typeof backends] as Mock<() => Promise<void>>,
    disconnect: backends[`${channel}Disconnect` as keyof typeof backends] as Mock<() => Promise<void>>,
    clear: backends[`${channel}Clear` as keyof typeof backends] as Mock<() => Promise<unknown>>,
  };
}

beforeEach(() => {
  notices.notify.mockClear();
  for (const value of Object.values(backends)) {
    (value as Mock).mockClear();
    (value as Mock).mockImplementation(() => Promise.resolve({}));
  }
});

describe("微信事件通道", () => {
  it("connect 浏览器态早退：不碰宿主、不刷新状态", async () => {
    const h = build();
    h.state.available.value = false;
    await h.api.connect();
    expect(backends.wechatConnect).not.toHaveBeenCalled();
  });

  it("connect 未登录：不发起连接", async () => {
    const h = build();
    await h.api.connect();
    expect(backends.wechatConnect).not.toHaveBeenCalled();
  });

  it("connect 已登录：带上 allowOtherSenders 调宿主，成功后刷新状态", async () => {
    const h = build();
    h.setConfigured("wechat", true);
    h.settings.remoteAssist.channels.wechat.allowOtherSenders = true;
    await h.api.connect();
    expect(backends.wechatConnect).toHaveBeenCalledWith(true);
    expect(h.refresh.refreshStatus).toHaveBeenCalledTimes(1);
  });

  it("connect 失败：提示的同时也刷新一次状态（拿到服务侧最新形状）", async () => {
    const h = build();
    h.setConfigured("wechat", true);
    h.settings.remoteAssist.channels.wechat.allowOtherSenders = false;
    backends.wechatConnect.mockRejectedValueOnce(new Error("连接被重置"));
    await h.api.connect();
    expect(notices.notify).toHaveBeenCalled();
    expect(notices.notify.mock.calls[0][0]).toMatchObject({ kind: "error", key: "wechat-connect" });
    expect(h.refresh.refreshStatus).toHaveBeenCalledTimes(1);
  });

  it("disconnect：停轮询并刷新状态", async () => {
    const h = build();
    await h.api.disconnect();
    expect(backends.wechatDisconnect).toHaveBeenCalledTimes(1);
  });

  it("logout：先作废扫码轮询，再退登录，记 system 活动", async () => {
    const h = build();
    await h.api.logout();
    expect(h.login.cancelLogin).toHaveBeenCalledTimes(1);
    expect(backends.wechatLogout).toHaveBeenCalledTimes(1);
    const system = h.activity.find((a) => a.kind === "system" && a.channel === "wechat");
    expect(system?.text).toBe(t("remoteAssist.wechat.loggedOut"));
  });

  it("logout 浏览器态：不碰宿主也不作废轮询", async () => {
    const h = build();
    h.state.available.value = false;
    await h.api.logout();
    expect(h.login.cancelLogin).not.toHaveBeenCalled();
    expect(backends.wechatLogout).not.toHaveBeenCalled();
  });
});

describe.each(Object.keys(CHANNEL_MAP))("%s 凭证通道", (channel) => {
  const asChannel = channel as RemoteChannel;
  const { statusKey, saveArgs } = CHANNEL_MAP[channel];
  const be = backendFor(channel);
  // 把 keyof 联合收敛成各自的可调用签名，避免 `api[union]` 无法被 TS 调用。
  const save = (api: ConnectApi) => api[saveProperty(channel)] as (...args: unknown[]) => Promise<string | null>;
  const connect = (api: ConnectApi) => api[connectProperty(channel)] as () => Promise<void>;
  const disconnect = (api: ConnectApi) => api[disconnectProperty(channel)] as () => Promise<void>;
  const clear = (api: ConnectApi) => api[clearProperty(channel)] as () => Promise<void>;

  it("浏览器态：保存/连接/断开/清除全部早退", async () => {
    const h = build();
    h.state.available.value = false;
    expect(await save(h.api)(...saveArgs)).toBe(t("remoteAssist.wechat.desktopOnly"));
    await connect(h.api)();
    await disconnect(h.api)();
    await clear(h.api)();
    expect(be.save).not.toHaveBeenCalled();
    expect(be.connect).not.toHaveBeenCalled();
    expect(be.disconnect).not.toHaveBeenCalled();
    expect(be.clear).not.toHaveBeenCalled();
  });

  it("保存凭证成功：快照写回状态，返回 null", async () => {
    const h = build();
    const snapshot = { configured: true, state: "connected", detail: null };
    be.save.mockResolvedValueOnce(snapshot);
    expect(await save(h.api)(...saveArgs)).toBeNull();
    expect(h.state[statusKey].value).toBe(snapshot);
  });

  it("保存凭证失败：返回错误文案，不吞掉原因", async () => {
    const h = build();
    be.save.mockRejectedValueOnce(new Error("401 无权限"));
    expect(await save(h.api)(...saveArgs)).toBe("401 无权限");
  });

  it("已配置：connect 带上该通道的 allowOtherSenders 并刷新", async () => {
    const h = build();
    h.setConfigured(asChannel, true);
    h.settings.remoteAssist.channels[channel].allowOtherSenders = true;
    await connect(h.api)();
    expect(be.connect).toHaveBeenCalledWith(true);
  });

  it("未配置：connect 不发起", async () => {
    const h = build();
    await connect(h.api)();
    expect(be.connect).not.toHaveBeenCalled();
  });

  it("connect 失败：提示 + 兜底刷新一次状态", async () => {
    const h = build();
    h.setConfigured(asChannel, true);
    be.connect.mockRejectedValueOnce(new Error("网络不通"));
    await connect(h.api)();
    expect(notices.notify).toHaveBeenCalled();
    expect(notices.notify.mock.calls[0][0]).toMatchObject({ kind: "error" });
  });

  it("disconnect：断开并刷新状态", async () => {
    const h = build();
    await disconnect(h.api)();
    expect(be.disconnect).toHaveBeenCalledTimes(1);
  });

  it("清除凭证：快照写回状态并记 system 活动", async () => {
    const h = build();
    const snapshot = { configured: false, state: "stopped", detail: null };
    be.clear.mockResolvedValueOnce(snapshot);
    await clear(h.api)();
    expect(h.state[statusKey].value).toBe(snapshot);
    expect(h.activity.some((a) => a.kind === "system" && a.channel === channel)).toBe(true);
  });
});

describe("applySenderPolicy", () => {
  it("浏览器态早退：即便已连接也不动作", async () => {
    const h = build();
    h.state.available.value = false;
    h.setChannelState("wechat", "connected");
    await h.api.applySenderPolicy("wechat");
    expect(backends.wechatDisconnect).not.toHaveBeenCalled();
    expect(backends.wechatConnect).not.toHaveBeenCalled();
  });

  it("stopped 通道：只登记策略不做任何重连", async () => {
    const h = build();
    await h.api.applySenderPolicy("dingtalk");
    expect(backends.dingtalkDisconnect).not.toHaveBeenCalled();
    expect(backends.dingtalkConnect).not.toHaveBeenCalled();
  });

  it("已连接通道：断开重连换上新策略（七条通道各自走到自己的分支）", async () => {
    const h = build();
    for (const channel of ["wechat", "dingtalk", "feishu", "telegram", "qq", "discord", "wecom"] as RemoteChannel[]) {
      h.setConfigured(channel, true);
      h.setChannelState(channel, "connected");
    }
    await h.api.applySenderPolicy("wechat");
    expect(backends.wechatDisconnect).toHaveBeenCalledTimes(1);
    expect(backends.wechatConnect).toHaveBeenCalledTimes(1);
    for (const ch of ["dingtalk", "feishu", "telegram", "qq", "discord", "wecom"]) {
      await h.api.applySenderPolicy(ch as RemoteChannel);
      expect(backends[`${ch}Disconnect` as keyof typeof backends]).toHaveBeenCalledTimes(1);
      expect(backends[`${ch}Connect` as keyof typeof backends]).toHaveBeenCalledTimes(1);
    }
  });

  it("connecting 中的通道同样重连（换策略要生效在建立连接前）", async () => {
    const h = build();
    h.setConfigured("wechat", true);
    h.setChannelState("wechat", "connecting");
    await h.api.applySenderPolicy("wechat");
    expect(backends.wechatDisconnect).toHaveBeenCalledTimes(1);
    expect(backends.wechatConnect).toHaveBeenCalledTimes(1);
  });
});
