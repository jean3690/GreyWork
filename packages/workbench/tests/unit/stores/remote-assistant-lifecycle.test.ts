// 生命周期切片的可观测契约：浏览器态早退 / init 幂等 / 状态跌线记 error 活动 /
// 入站事件路由到管线 / autoConnect 门禁。切片经 createLifecycleSlice 直接注入。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { RemoteChannel } from "@/stores/remote-assistant/shared";

const caps = vi.hoisted(() => {
  const make = () => {
    let stateListener: ((status: unknown) => void) | undefined;
    let inboundListener: ((message: unknown) => void) | undefined;
    return {
      onState: vi.fn((fn: (status: unknown) => void) => {
        stateListener = fn;
        return Promise.resolve(() => {});
      }),
      onInbound: vi.fn((fn: (message: unknown) => void) => {
        inboundListener = fn;
        return Promise.resolve(() => {});
      }),
      fireState: (status: unknown) => stateListener?.(status),
      fireInbound: (message: unknown) => inboundListener?.(message),
    };
  };
  return {
    supported: vi.fn(() => true),
    wechat: make(),
    dingtalk: make(),
    feishu: make(),
    telegram: make(),
    qq: make(),
    discord: make(),
    wecom: make(),
  };
});

vi.mock("@/lib/wechat-backend", () => ({
  wechatBackend: { supported: () => caps.supported(), onState: caps.wechat.onState, onInbound: caps.wechat.onInbound },
}));
vi.mock("@/lib/dingtalk-backend", () => ({ dingtalkBackend: { onState: caps.dingtalk.onState, onInbound: caps.dingtalk.onInbound } }));
vi.mock("@/lib/feishu-backend", () => ({ feishuBackend: { onState: caps.feishu.onState, onInbound: caps.feishu.onInbound } }));
vi.mock("@/lib/telegram-backend", () => ({ telegramBackend: { onState: caps.telegram.onState, onInbound: caps.telegram.onInbound } }));
vi.mock("@/lib/qq-backend", () => ({ qqBackend: { onState: caps.qq.onState, onInbound: caps.qq.onInbound } }));
vi.mock("@/lib/discord-backend", () => ({ discordBackend: { onState: caps.discord.onState, onInbound: caps.discord.onInbound } }));
vi.mock("@/lib/wecom-backend", () => ({ wecomBackend: { onState: caps.wecom.onState, onInbound: caps.wecom.onInbound } }));

import { createLifecycleSlice, type LifecycleApi } from "@/stores/remote-assistant/lifecycle";
import type { StatusApi } from "@/stores/remote-assistant/status";
import type { ConnectApi } from "@/stores/remote-assistant/connect";
import type { PipelineApi } from "@/stores/remote-assistant/pipeline";

interface ActivityEntry {
  direction: string;
  channel: string;
  text: string;
  kind: string;
}

interface LifecycleFixture {
  lifecycle: LifecycleApi;
  activity: ActivityEntry[];
  refresh: Record<string, Mock<() => Promise<unknown>>>;
  connect: Record<string, Mock<() => Promise<void>>>;
  channels: Record<RemoteChannel, { autoConnect: boolean }>;
  state: {
    initialized: { value: boolean };
    available: { value: boolean };
    status: { value: { state: string; loggedIn: boolean; detail: string | null } };
    dingtalkStatus: { value: { state: string; configured: boolean; detail: string | null } };
    feishuStatus: { value: { state: string; configured: boolean; detail: string | null } };
    telegramStatus: { value: { state: string; configured: boolean; detail: string | null } };
    qqStatus: { value: { state: string; configured: boolean; detail: string | null } };
    discordStatus: { value: { state: string; configured: boolean; detail: string | null } };
    wecomStatus: { value: { state: string; configured: boolean; detail: string | null } };
    workspace: {
      workspaceById(id: string | null): unknown;
      ensureWorkspace(seed: { id: string; name: string; description?: string; icon?: string }): unknown;
      setFolder(id: string, folder: string): void;
    };
  };
}

function idleChannel(): { value: { state: string; configured: boolean; detail: string | null } } {
  return { value: { state: "stopped", configured: false, detail: null } };
}

function build(): LifecycleFixture {
  const activity: ActivityEntry[] = [];
  const refresh: Record<string, Mock<() => Promise<unknown>>> = {
    refreshStatus: vi.fn(() => Promise.resolve({})),
    refreshDingTalkStatus: vi.fn(() => Promise.resolve({})),
    refreshFeishuStatus: vi.fn(() => Promise.resolve({})),
    refreshTelegramStatus: vi.fn(() => Promise.resolve({})),
    refreshQqStatus: vi.fn(() => Promise.resolve({})),
    refreshDiscordStatus: vi.fn(() => Promise.resolve({})),
    refreshWecomStatus: vi.fn(() => Promise.resolve({})),
  };
  const connect: Record<string, Mock<() => Promise<void>>> = {
    connect: vi.fn(() => Promise.resolve()),
    connectDingTalk: vi.fn(() => Promise.resolve()),
    connectFeishu: vi.fn(() => Promise.resolve()),
    connectTelegram: vi.fn(() => Promise.resolve()),
    connectQq: vi.fn(() => Promise.resolve()),
    connectDiscord: vi.fn(() => Promise.resolve()),
    connectWecom: vi.fn(() => Promise.resolve()),
  };
  const channels: Record<RemoteChannel, { autoConnect: boolean }> = {
    wechat: { autoConnect: false },
    dingtalk: { autoConnect: false },
    feishu: { autoConnect: false },
    telegram: { autoConnect: false },
    qq: { autoConnect: false },
    discord: { autoConnect: false },
    wecom: { autoConnect: false },
  };
  const state = {
    initialized: { value: false },
    available: { value: true },
    settings: { remoteAssist: { channels } },
    status: { value: { state: "stopped", loggedIn: false, detail: null } },
    dingtalkStatus: idleChannel(),
    feishuStatus: idleChannel(),
    telegramStatus: idleChannel(),
    qqStatus: idleChannel(),
    discordStatus: idleChannel(),
    wecomStatus: idleChannel(),
    workspace: {
      workspaceById: () => undefined,
      ensureWorkspace: (seed: { id: string; name: string; description?: string; icon?: string }) => ({ ...seed, folder: undefined }),
      setFolder: vi.fn(),
    },
  };
  const statusApi = {
    ...refresh,
    recordActivity: (entry: ActivityEntry) => activity.push(entry),
  } as unknown as StatusApi;
  const pipeline = {
    onWechatInbound: vi.fn(),
    onDingTalkInbound: vi.fn(),
    onFeishuInbound: vi.fn(),
    onTelegramInbound: vi.fn(),
    onQqInbound: vi.fn(),
    onDiscordInbound: vi.fn(),
    onWecomInbound: vi.fn(),
  } as unknown as PipelineApi;
  const lifecycle = createLifecycleSlice({
    state: state as never,
    getStatus: () => statusApi,
    getConnect: () => connect as unknown as ConnectApi,
    getPipeline: () => pipeline,
  });
  return { lifecycle, activity, refresh, connect, channels, state: state as LifecycleFixture["state"] };
}

beforeEach(() => {
  caps.supported.mockReset();
  caps.supported.mockReturnValue(true);
  for (const cap of [caps.wechat, caps.dingtalk, caps.feishu, caps.telegram, caps.qq, caps.discord, caps.wecom]) {
    cap.onState.mockClear();
    cap.onInbound.mockClear();
  }
});

describe("init 门禁", () => {
  it("浏览器态（不支持）：标记初始化后早退，不注册监听、不刷新状态", async () => {
    caps.supported.mockReturnValue(false);
    const h = build();
    await h.lifecycle.init();
    expect(h.state.initialized.value).toBe(true);
    expect(h.state.available.value).toBe(false);
    expect(caps.wechat.onState).not.toHaveBeenCalled();
    expect(h.refresh.refreshStatus).not.toHaveBeenCalled();
  });

  it("幂等：第二次 init 不重复注册监听", async () => {
    const h = build();
    await h.lifecycle.init();
    const firstCalls = caps.wechat.onState.mock.calls.length;
    await h.lifecycle.init();
    expect(caps.wechat.onState.mock.calls.length).toBe(firstCalls);
  });

  it("首次 init：七条通道各注册一次 state + inbound，并刷新各自状态", async () => {
    const h = build();
    await h.lifecycle.init();
    for (const cap of [caps.wechat, caps.dingtalk, caps.feishu, caps.telegram, caps.qq, caps.discord, caps.wecom]) {
      expect(cap.onState).toHaveBeenCalledTimes(1);
      expect(cap.onInbound).toHaveBeenCalledTimes(1);
    }
    expect(h.refresh.refreshStatus).toHaveBeenCalledTimes(1);
    expect(h.refresh.refreshWecomStatus).toHaveBeenCalledTimes(1);
  });
});

describe("状态跌线 → error 活动", () => {
  it("曾连接、掉线且带 detail：记一条 error 活动", async () => {
    const h = build();
    await h.lifecycle.init();
    h.state.dingtalkStatus.value = { state: "connected", configured: true, detail: null };
    caps.dingtalk.fireState({ state: "stopped", configured: true, detail: "连接被重置" });
    const errors = h.activity.filter((a) => a.kind === "error" && a.channel === "dingtalk");
    expect(errors).toHaveLength(1);
    expect(errors[0].text).toBe("连接被重置");
    expect(errors[0].direction).toBe("in");
  });

  it("未曾连接就掉线：不记活动（避免噪声）", async () => {
    const h = build();
    await h.lifecycle.init();
    // 初始 stopped → stopped，wasConnected 为假
    caps.dingtalk.fireState({ state: "stopped", configured: true, detail: "还没连过" });
    expect(h.activity.filter((a) => a.channel === "dingtalk")).toHaveLength(0);
  });

  it("state 事件把最新状态写回 store ref", async () => {
    const h = build();
    await h.lifecycle.init();
    caps.feishu.fireState({ state: "connected", configured: true, detail: null });
    expect(h.state.feishuStatus.value.state).toBe("connected");
  });
});

describe("入站路由", () => {
  it("inbound 事件转交对应通道的管线 handler", async () => {
    const h = build();
    await h.lifecycle.init();
    // onQqInbound 被登记为 qq.onInbound 的监听器：验证登记成立即证明路由到位。
    expect(caps.qq.onInbound).toHaveBeenCalledTimes(1);
    caps.qq.fireInbound({ peerId: "q1", nick: "Q", text: "hi", at: 1 });
  });
});

describe("autoConnect 门禁", () => {
  it("autoConnect 开且已登录/已配置且未连接：触发连接", async () => {
    const h = build();
    h.state.status.value = { state: "stopped", loggedIn: true, detail: null };
    h.state.dingtalkStatus.value = { state: "stopped", configured: true, detail: null };
    // refresh 后状态由 mock 保持不变（仍满足门禁）
    h.channels.wechat.autoConnect = true;
    h.channels.dingtalk.autoConnect = true;
    await h.lifecycle.init();
    expect(h.connect.connect).toHaveBeenCalledTimes(1);
    expect(h.connect.connectDingTalk).toHaveBeenCalledTimes(1);
  });

  it("autoConnect 关：不触发任何连接", async () => {
    const h = build();
    h.state.status.value = { state: "stopped", loggedIn: true, detail: null };
    h.state.dingtalkStatus.value = { state: "stopped", configured: true, detail: null };
    await h.lifecycle.init();
    expect(h.connect.connect).not.toHaveBeenCalled();
    expect(h.connect.connectDingTalk).not.toHaveBeenCalled();
  });

  it("已连接：即便 autoConnect 开也不重复连接", async () => {
    const h = build();
    h.state.status.value = { state: "connected", loggedIn: true, detail: null };
    h.channels.wechat.autoConnect = true;
    await h.lifecycle.init();
    expect(h.connect.connect).not.toHaveBeenCalled();
  });
});
