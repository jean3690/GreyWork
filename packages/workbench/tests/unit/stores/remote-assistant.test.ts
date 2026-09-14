// 远程助手 store 契约：扫码登录状态机、按设置自动连接、入站消息 → 本机助手 → 回发。
//
// 宿主 IPC 与 LLM 客户端都是替身（vi.mock）：这里验证的是「编排」——
// 事件怎么接、回复怎么串、失败与非文本怎么收场，而不是 Tauri 或模型本身。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { LlmChatParams } from "@greywork/llm";
import type { WechatInbound, WechatLoginPoll, WechatStatus } from "@/lib/wechat-backend";
import type { FeishuStatus } from "@/lib/feishu-backend";
import type { GlobalTurnOptions } from "@/stores/agent";

const agentMock = vi.hoisted(() => ({
  agentProviders: [{ id: "acp-1", name: "Codex", kind: "acp" as const, command: "codex acp", enabled: true }],
  selectedProviderId: "other",
  acpBusy: false,
  acpConnecting: false,
  selectProvider: vi.fn(),
  sendGlobalTurn: vi.fn(async (_text: string, _providerName: string, _options: GlobalTurnOptions) => {}),
}));

const mocks = vi.hoisted(() => {
  const feishuListeners: ((message: unknown) => void)[] = [];
  const feishu = {
    supported: () => true,
    status: vi.fn(
      async (): Promise<FeishuStatus> => ({
        configured: false,
        appId: null,
        state: "stopped",
        detail: null,
        lastMessageAt: null,
        peerCount: 0,
      }),
    ),
    saveCredentials: vi.fn(),
    clearCredentials: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    registerBegin: vi.fn(),
    registerPoll: vi.fn(),
    registerCancel: vi.fn(),
    onState: vi.fn(async () => () => {}),
    onInbound: vi.fn(async (listener: (message: unknown) => void) => {
      feishuListeners.push(listener);
      return () => {};
    }),
  };
  const stateListeners: ((status: unknown) => void)[] = [];
  const inboundListeners: ((message: unknown) => void)[] = [];
  let llmListener: ((event: unknown) => void) | null = null;
  const backend = {
    supported: () => true,
    status: vi.fn(),
    loginQr: vi.fn(),
    loginPoll: vi.fn(),
    loginCancel: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    logout: vi.fn(),
    send: vi.fn(),
    sendTyping: vi.fn(),
    onState: vi.fn(async (listener: (status: unknown) => void) => {
      stateListeners.push(listener);
      return () => {};
    }),
    onInbound: vi.fn(async (listener: (message: unknown) => void) => {
      inboundListeners.push(listener);
      return () => {};
    }),
  };
  const llmClient = {
    isAvailable: () => true,
    chat: vi.fn(async (_params: LlmChatParams) => 1),
    stop: vi.fn(async () => {}),
    onEvent: vi.fn(async (listener: (event: unknown) => void) => {
      llmListener = listener;
      return () => {};
    }),
  };
  return {
    backend,
    feishu,
    feishuListeners,
    llmClient,
    stateListeners,
    inboundListeners,
    emitLlm: (event: unknown) => llmListener?.(event),
  };
});

vi.mock("@/lib/wechat-backend", () => ({ wechatBackend: mocks.backend }));
vi.mock("@greywork/llm", () => ({ createLlmClient: () => mocks.llmClient }));
vi.mock("@/lib/feishu-backend", () => ({ feishuBackend: mocks.feishu }));
vi.mock("@/lib/dingtalk-backend", () => ({
  dingtalkBackend: {
    supported: () => true,
    status: vi.fn(async () => ({
      configured: false,
      clientId: null,
      state: "stopped",
      detail: null,
      lastMessageAt: null,
      peerCount: 0,
    })),
    saveCredentials: vi.fn(),
    clearCredentials: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    onState: vi.fn(async () => () => {}),
    onInbound: vi.fn(async () => () => {}),
  },
}));
vi.mock("@/stores/agent", () => ({ useAgentStore: () => agentMock }));

import { useRemoteAssistantStore } from "@/stores/remote-assistant";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";

const IDLE: WechatStatus = {
  loggedIn: false,
  userId: null,
  botId: null,
  state: "stopped",
  detail: null,
  lastMessageAt: null,
  pendingLogin: false,
};

let host: WechatStatus = { ...IDLE };

function inbound(overrides: Partial<WechatInbound> = {}): WechatInbound {
  return {
    messageId: 7,
    fromUserId: "peer@im.wechat",
    contextToken: "ctx-1",
    text: "帮我看看今天的安排",
    itemTypes: [1],
    createTimeMs: 1_730_000_000_000,
    at: Date.now(),
    ...overrides,
  };
}

/** 等编排里的若干次 await 走完（队列 + 会话写入 + 发送）：纯微任务，不依赖真实计时。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

beforeEach(() => {
  setActivePinia(createPinia());
  host = { ...IDLE };
  mocks.stateListeners.length = 0;
  mocks.inboundListeners.length = 0;
  vi.clearAllMocks();
  mocks.backend.status.mockImplementation(async () => ({ ...host }));
  mocks.backend.loginQr.mockResolvedValue({ content: "https://liteapp.weixin.qq.com/q/demo" });
  mocks.backend.loginPoll.mockResolvedValue({ status: "wait" } as WechatLoginPoll);
  mocks.backend.connect.mockResolvedValue(undefined);
  mocks.backend.disconnect.mockResolvedValue(undefined);
  mocks.backend.logout.mockResolvedValue(undefined);
  mocks.backend.send.mockResolvedValue(undefined);
  mocks.backend.sendTyping.mockResolvedValue(undefined);
  mocks.backend.loginCancel.mockResolvedValue(undefined);
  mocks.feishu.status.mockResolvedValue({
    configured: false,
    appId: null,
    state: "stopped",
    detail: null,
    lastMessageAt: null,
    peerCount: 0,
  });
  mocks.feishu.send.mockResolvedValue(undefined);
  mocks.feishu.registerBegin.mockResolvedValue({
    qrUrl: "https://open.feishu.cn/page/launcher?user_code=LF7S-N6L6",
    userCode: "LF7S-N6L6",
    expiresIn: 3600,
    interval: 1,
  });
  mocks.feishu.registerPoll.mockReset();
  mocks.feishu.registerPoll.mockResolvedValue({ state: "pending", detail: null, appId: null, intervalMs: 1000 });
  mocks.feishu.registerCancel.mockResolvedValue(undefined);
  mocks.llmClient.chat.mockResolvedValue(1);
  mocks.feishuListeners.length = 0;
  agentMock.selectedProviderId = "other";
  agentMock.acpBusy = false;
  agentMock.acpConnecting = false;
  agentMock.selectProvider.mockClear();
  agentMock.sendGlobalTurn.mockClear();
  agentMock.sendGlobalTurn.mockResolvedValue(undefined);
});

describe("远程助手 store", () => {
  it("init 注册事件并按 autoConnect 自动连接（默认只放行扫码本人）", async () => {
    host = { ...IDLE, loggedIn: true, userId: "me@im.wechat", botId: "bot-1" };
    const store = useRemoteAssistantStore();
    await store.init();
    await settle();

    expect(mocks.inboundListeners).toHaveLength(1);
    expect(mocks.stateListeners).toHaveLength(1);
    expect(mocks.backend.connect).toHaveBeenCalledWith(false);
    expect(store.status.loggedIn).toBe(true);
  });

  it("autoConnect 关闭时不自动连接", async () => {
    host = { ...IDLE, loggedIn: true, userId: "me@im.wechat" };
    const settings = useSettingsStore();
    settings.setChannelPrefs("wechat", { autoConnect: false });
    const store = useRemoteAssistantStore();
    await store.init();
    await settle();
    expect(mocks.backend.connect).not.toHaveBeenCalled();
  });

  it("扫码流程：等待 → 确认后刷新状态并自动连接", async () => {
    vi.useFakeTimers();
    try {
      mocks.backend.loginPoll
        .mockResolvedValueOnce({ status: "wait" } as WechatLoginPoll)
        .mockResolvedValueOnce({ status: "confirmed", userId: "me@im.wechat", botId: "bot-1" } as WechatLoginPoll);
      host = { ...IDLE, loggedIn: true, userId: "me@im.wechat", botId: "bot-1" };

      const store = useRemoteAssistantStore();
      await store.startLogin();
      expect(store.qr?.content).toContain("liteapp.weixin.qq.com");
      // 轮询之间有最小间隔（防宿主秒回时热循环）：推进时钟跨过它。
      await vi.advanceTimersByTimeAsync(1_100);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(store.qr).toBeNull();
      expect(store.qrError).toBeNull();
      expect(mocks.backend.connect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("二维码多次过期：宿主放弃刷新时报错并停止轮询", async () => {
    mocks.backend.loginPoll.mockResolvedValue({ status: "expired" } as WechatLoginPoll);
    const store = useRemoteAssistantStore();
    await store.startLogin();
    await settle();

    expect(store.qr).toBeNull();
    expect(store.qrError).not.toBeNull();
    expect(mocks.backend.loginPoll).toHaveBeenCalledTimes(1);
  });

  it("入站文本：走真实 LLM 流并回发纯文本，往来落进联系人会话", async () => {
    const settings = useSettingsStore();
    settings.upsertModelProvider({
      id: "test-provider",
      name: "Test",
      kind: "custom",
      baseUrl: "https://llm.test/v1",
      model: "m",
      apiKeyEnv: "TEST_KEY",
      enabled: true,
    });
    settings.selectModelProvider("test-provider");

    const store = useRemoteAssistantStore();
    await store.init();
    mocks.inboundListeners[0](inbound());
    await vi.waitFor(() => expect(mocks.llmClient.chat).toHaveBeenCalled());

    const params = mocks.llmClient.chat.mock.calls[0][0];
    expect(typeof params.clientToken).toBe("string");
    expect(params.messages.some((message) => message.content === "帮我看看今天的安排")).toBe(true);

    mocks.emitLlm({ kind: "llm-delta", payload: { delta: "**八点** 有个会", clientToken: params.clientToken } });
    mocks.emitLlm({ kind: "llm-done", payload: { clientToken: params.clientToken } });
    await vi.waitFor(() => expect(mocks.backend.send).toHaveBeenCalled());

    // 回发的是去 Markdown 的纯文本
    expect(mocks.backend.send).toHaveBeenCalledWith("peer@im.wechat", "ctx-1", "八点 有个会");
    // 「正在输入」开与关都发过
    expect(mocks.backend.sendTyping).toHaveBeenCalledWith("peer@im.wechat", "ctx-1", true);
    expect(mocks.backend.sendTyping).toHaveBeenCalledWith("peer@im.wechat", "ctx-1", false);

    // 往来落进以联系人为名的会话（收消息不应把激活位切走）
    const sessionStore = useSessionStore();
    const session = sessionStore.sessions.find((candidate) => candidate.title === "微信 · peer");
    expect(session).toBeDefined();
    expect(session?.messages.map((message) => message.content)).toEqual(["帮我看看今天的安排", "**八点** 有个会"]);
    expect(sessionStore.activeSessionId).not.toBe(session?.id);

    // 活动流：一条入站 + 一条出站
    expect(store.activity.some((item) => item.direction === "in" && item.text.includes("安排"))).toBe(true);
    expect(store.activity.some((item) => item.direction === "out" && item.text === "八点 有个会")).toBe(true);
  });

  it("非文本消息不喂模型，如实回一句只认文字", async () => {
    const store = useRemoteAssistantStore();
    await store.init();
    mocks.inboundListeners[0](inbound({ text: "", itemTypes: [2] }));
    await vi.waitFor(() => expect(mocks.backend.send).toHaveBeenCalled());

    expect(mocks.llmClient.chat).not.toHaveBeenCalled();
    expect(mocks.backend.send).toHaveBeenCalledWith("peer@im.wechat", "ctx-1", "我暂时只认得文字消息，发段文字给我吧～");
    expect(store.activity.some((item) => item.kind === "unsupported")).toBe(true);
  });

  it("autoReply 关闭时只记录不回复", async () => {
    const settings = useSettingsStore();
    settings.setChannelPrefs("wechat", { autoReply: false });
    const store = useRemoteAssistantStore();
    await store.init();
    mocks.inboundListeners[0](inbound());
    await settle();

    expect(mocks.llmClient.chat).not.toHaveBeenCalled();
    expect(mocks.backend.send).not.toHaveBeenCalled();
    expect(store.activity.some((item) => item.direction === "in")).toBe(true);
  });

  it("未配置可用供应商：回一句说明而不是静默失败", async () => {
    // 默认供应商清单里有可用项：全部停用才构成「没有供应商」的场景。
    const settings = useSettingsStore();
    for (const provider of settings.modelProviders) settings.upsertModelProvider({ ...provider, enabled: false });
    settings.selectModelProvider(null);

    const store = useRemoteAssistantStore();
    await store.init();
    mocks.inboundListeners[0](inbound());
    await vi.waitFor(() => expect(mocks.backend.send).toHaveBeenCalled());

    expect(mocks.llmClient.chat).not.toHaveBeenCalled();
    expect(mocks.backend.send).toHaveBeenCalledWith("peer@im.wechat", "ctx-1", "本机尚未配置可用的模型供应商，暂时无法回复。");
    expect(store.activity.some((item) => item.kind === "error")).toBe(true);
  });

  it("连接状态事件进入 store，异常说明落进活动流", async () => {
    const store = useRemoteAssistantStore();
    await store.init();
    mocks.stateListeners[0]({ ...IDLE, state: "connected", loggedIn: true, userId: "me@im.wechat" });
    expect(store.connected).toBe(true);
    mocks.stateListeners[0]({ ...IDLE, state: "error", loggedIn: true, detail: "网络不可达" });
    expect(store.connected).toBe(false);
    expect(store.activity.some((item) => item.text === "网络不可达")).toBe(true);
  });

  it("断开 / 退出登录：各自落到宿主并刷新状态", async () => {
    host = { ...IDLE, loggedIn: true, userId: "me@im.wechat", state: "connected" };
    const store = useRemoteAssistantStore();
    await store.init();
    expect(store.connected).toBe(true);

    host = { ...IDLE, loggedIn: true, userId: "me@im.wechat", state: "stopped" };
    await store.disconnect();
    expect(mocks.backend.disconnect).toHaveBeenCalled();
    expect(store.connected).toBe(false);

    host = { ...IDLE };
    await store.logout();
    expect(mocks.backend.logout).toHaveBeenCalled();
    expect(store.status.loggedIn).toBe(false);
    expect(store.activity.some((item) => item.kind === "system")).toBe(true);
  });

  it("发送者策略变更：已连接时重连一次让宿主换用新策略", async () => {
    host = { ...IDLE, loggedIn: true, userId: "me@im.wechat", state: "connected" };
    const store = useRemoteAssistantStore();
    await store.init();
    mocks.backend.disconnect.mockClear();
    mocks.backend.connect.mockClear();

    await store.applySenderPolicy("wechat");
    expect(mocks.backend.disconnect).toHaveBeenCalled();
    expect(mocks.backend.connect).toHaveBeenCalled();
  });

  it("连接失败：给出通知并把宿主的最后状态拉回来", async () => {
    useSettingsStore().setChannelPrefs("wechat", { autoConnect: false });
    host = { ...IDLE, loggedIn: true, userId: "me@im.wechat", state: "error", detail: "宿主拒绝" };
    const store = useRemoteAssistantStore();
    await store.init();
    mocks.backend.connect.mockRejectedValueOnce(new Error("宿主编译中"));

    await store.connect();
    expect(store.status.state).toBe("error");
    expect(store.status.detail).toBe("宿主拒绝");
  });

  it("ACP 模式：用设置里指定的后端跑一轮，终稿发回微信", async () => {
    useSettingsStore().setRemoteAssist({ replyMode: "acp", replyProviderId: "acp-1" });
    const store = useRemoteAssistantStore();
    await store.init();
    mocks.inboundListeners[0](inbound());
    await vi.waitFor(() => expect(agentMock.sendGlobalTurn).toHaveBeenCalled());

    const [text, providerName, options] = agentMock.sendGlobalTurn.mock.calls[0] as [
      string,
      string,
      {
        reuseScaffold: { threadId: string; message: { id: string } };
        hooks: { onPromptDone: (ctx: { threadId: string; messageId: string }) => void };
      },
    ];
    expect(text).toBe("帮我看看今天的安排");
    expect(providerName).toBe("Codex");
    expect(agentMock.selectProvider).toHaveBeenCalledWith("acp-1");
    const scaffoldRef = options.reuseScaffold;
    expect(scaffoldRef).toBeDefined();
    expect(scaffoldRef?.threadId).toBeTruthy();

    // 模拟 agent 把终稿写进支架并收尾
    const sessionStore = useSessionStore();
    const session = sessionStore.sessions.find((candidate) => candidate.title === "微信 · peer");
    expect(session).toBeDefined();
    const scaffold = session?.messages.at(-1);
    expect(scaffold?.id).toBe(scaffoldRef?.message.id);
    if (scaffold) scaffold.content = "**八点** 有个会";
    options.hooks?.onPromptDone?.({ threadId: session?.id ?? "", messageId: scaffold?.id ?? "" });

    await vi.waitFor(() => expect(mocks.backend.send).toHaveBeenCalledWith("peer@im.wechat", "ctx-1", "八点 有个会"));
    expect(mocks.llmClient.chat).not.toHaveBeenCalled();
  });

  it("ACP 模式但没选到后端：如实回一句让用户去设置里选", async () => {
    useSettingsStore().setRemoteAssist({ replyMode: "acp", replyProviderId: "missing-provider" });
    const store = useRemoteAssistantStore();
    await store.init();
    mocks.inboundListeners[0](inbound());
    await vi.waitFor(() => expect(mocks.backend.send).toHaveBeenCalled());
    expect(agentMock.sendGlobalTurn).not.toHaveBeenCalled();
    expect((mocks.backend.send.mock.calls[0] as string[])[2]).toContain("未选择可用的 ACP 后端");
  });

  it("桌面端手发：写进会话并走宿主命令；没凭据的联系人直接拒绝", async () => {
    useSettingsStore().setChannelPrefs("wechat", { autoReply: false });
    host = { ...IDLE, loggedIn: true, userId: "me@im.wechat", state: "connected" };
    const store = useRemoteAssistantStore();
    await store.init();
    await store.refreshStatus();
    mocks.inboundListeners[0](inbound());

    const ok = await store.sendFromDesktop("wechat:peer@im.wechat", "在的");
    expect(ok.ok).toBe(true);
    expect(mocks.backend.send).toHaveBeenCalledWith("peer@im.wechat", "ctx-1", "在的");
    const sessionStore = useSessionStore();
    const session = sessionStore.sessions.find((candidate) => candidate.title === "微信 · peer");
    expect(session?.messages.at(-1)?.content).toBe("在的");

    const denied = await store.sendFromDesktop("wechat:stranger@im.wechat", "hi");
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("找不到这个联系人");
  });

  it("联系人档案：入站即建档带凭据，读到即清未读", async () => {
    useSettingsStore().setChannelPrefs("wechat", { autoReply: false });
    const store = useRemoteAssistantStore();
    await store.init();
    mocks.inboundListeners[0](inbound());

    const peer = store.peerById("wechat:peer@im.wechat");
    expect(peer?.contextToken).toBe("ctx-1");
    expect(peer?.lastText).toBe("帮我看看今天的安排");
    expect(store.peerList).toHaveLength(1);
    expect(peer && peer.lastAt > peer.readAt).toBe(true);

    store.markPeerRead("wechat:peer@im.wechat");
    expect(store.peerById("wechat:peer@im.wechat")?.readAt).toBe(peer?.lastAt);
  });

  it("飞书入站：建档、按设置回复并走宿主的发送命令", async () => {
    const settings = useSettingsStore();
    settings.upsertModelProvider({
      id: "test-provider",
      name: "Test",
      kind: "custom",
      baseUrl: "https://llm.test/v1",
      model: "m",
      apiKeyEnv: "TEST_KEY",
      enabled: true,
    });
    settings.selectModelProvider("test-provider");
    mocks.feishu.status.mockResolvedValue({
      configured: true,
      appId: "cli-1",
      state: "connected",
      detail: null,
      lastMessageAt: null,
      peerCount: 0,
    });
    const store = useRemoteAssistantStore();
    await store.init();
    mocks.feishuListeners[0]({
      messageId: "om-1",
      peerId: "ou_owner",
      nick: "ou_owner",
      text: "帮我看看今天的安排",
      messageType: "text",
      chatType: "p2p",
      at: Date.now(),
    });
    await vi.waitFor(() => expect(mocks.llmClient.chat).toHaveBeenCalled());
    const params = mocks.llmClient.chat.mock.calls.at(-1)?.[0] as { clientToken: string };
    mocks.emitLlm({ kind: "llm-delta", payload: { delta: "早上好", clientToken: params.clientToken } });
    mocks.emitLlm({ kind: "llm-done", payload: { clientToken: params.clientToken } });

    await vi.waitFor(() => expect(mocks.feishu.send).toHaveBeenCalledWith("ou_owner", "早上好"));
    const peer = store.peerById("feishu:ou_owner");
    expect(peer?.nick).toBe("ou_owner");
    expect(store.connectedOf("feishu")).toBe(true);

    // 桌面端手发：飞书不需要 context_token（接收方信息在宿主）
    const sent = await store.sendFromDesktop("feishu:ou_owner", "在的");
    expect(sent.ok).toBe(true);
    expect(mocks.feishu.send).toHaveBeenCalledWith("ou_owner", "在的");
  });

  it("飞书扫码创建：出码 → 等确认 → 确认后刷新状态并自动连上", async () => {
    vi.useFakeTimers();
    try {
      mocks.feishu.registerPoll
        .mockReset()
        .mockResolvedValueOnce({ state: "pending", detail: null, appId: null, intervalMs: 1000 })
        .mockResolvedValueOnce({ state: "done", detail: null, appId: "cli_scan", intervalMs: null });
      // 宿主在凭证落盘后即可连接：扫码成功这一轮的状态就是「已配置 + 已连上」
      mocks.feishu.status.mockResolvedValue({
        configured: true,
        appId: "cli_scan",
        state: "connected",
        detail: null,
        lastMessageAt: null,
        peerCount: 0,
      });
      const store = useRemoteAssistantStore();

      await store.startFeishuRegistration();
      expect(store.feishuRegister.phase).toBe("waiting");
      expect(store.feishuRegister.qrUrl).toContain("user_code=LF7S-N6L6");
      expect(store.feishuRegister.userCode).toBe("LF7S-N6L6");
      expect(mocks.feishu.registerPoll).not.toHaveBeenCalled();

      // 第一轮：手机上还没确认
      await vi.advanceTimersByTimeAsync(1000);
      expect(store.feishuRegister.phase).toBe("waiting");

      // 第二轮：确认了 —— 凭证由宿主落盘，这里只刷新状态并连上
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(mocks.feishu.connect).toHaveBeenCalled());
      expect(store.feishuRegister.phase).toBe("done");
      expect(store.feishuRegister.qrUrl).toBeNull();
      expect(store.connectedOf("feishu")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("飞书扫码创建：手机上取消 → 如实给失败原因且不再轮询", async () => {
    vi.useFakeTimers();
    try {
      mocks.feishu.registerPoll.mockReset().mockResolvedValue({ state: "denied", detail: "user denied", appId: null, intervalMs: null });
      const store = useRemoteAssistantStore();

      await store.startFeishuRegistration();
      await vi.advanceTimersByTimeAsync(1000);
      expect(store.feishuRegister.phase).toBe("failed");
      // 服务端给了描述就用它（没给才落到本地文案）
      expect(store.feishuRegister.detail).toBe("user denied");
      expect(store.feishuRegister.qrUrl).toBeNull();

      const calls = mocks.feishu.registerPoll.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(mocks.feishu.registerPoll.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("飞书扫码创建：取消即作废宿主会话并停掉轮询", async () => {
    vi.useFakeTimers();
    try {
      const store = useRemoteAssistantStore();
      await store.startFeishuRegistration();
      await vi.advanceTimersByTimeAsync(1000);
      const calls = mocks.feishu.registerPoll.mock.calls.length;

      store.cancelFeishuRegistration();
      expect(store.feishuRegister.phase).toBe("idle");
      expect(mocks.feishu.registerCancel).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);
      expect(mocks.feishu.registerPoll.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("取消扫码：清掉二维码视图并通知宿主作废会话", async () => {
    const store = useRemoteAssistantStore();
    await store.startLogin();
    expect(store.qr).not.toBeNull();
    store.cancelLogin();
    expect(store.qr).toBeNull();
    await vi.waitFor(() => expect(mocks.backend.loginCancel).toHaveBeenCalled());
  });
});
