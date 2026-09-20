// 回复管线切片的可观测契约：入站路由 / 自动回复门禁 / LLM 回合交付 / 桌面手发的分支。
// 切片经 createPipelineSlice({ state, getStatus, getPeers }) 直接注入，绕开 pinia store。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LlmChatParams, LlmClient, LlmEventEnvelope } from "@greywork/llm";
import type { ModelProviderConfig } from "@greywork/shell";
import { i18n } from "@/i18n";
import type { ThreadMessage } from "@/types";
import type { RemoteChannel, RemotePeer } from "@/stores/remote-assistant/shared";

const t = i18n.global.t;

// 七条通道后端：只关心 send 是否被调用、带什么参数。
const backends = vi.hoisted(() => ({
  wechat: vi.fn<(id: string, token: string, text: string) => Promise<void>>(() => Promise.resolve()),
  wechatTyping: vi.fn<(id: string, token: string, typing: boolean) => Promise<void>>(() => Promise.resolve()),
  dingtalk: vi.fn<(id: string, text: string) => Promise<void>>(() => Promise.resolve()),
  feishu: vi.fn<(id: string, text: string) => Promise<void>>(() => Promise.resolve()),
  telegram: vi.fn<(id: string, text: string) => Promise<void>>(() => Promise.resolve()),
  qq: vi.fn<(id: string, text: string) => Promise<void>>(() => Promise.resolve()),
  discord: vi.fn<(id: string, text: string) => Promise<void>>(() => Promise.resolve()),
  wecom: vi.fn<(id: string, text: string) => Promise<void>>(() => Promise.resolve()),
}));

const chatLlm = vi.hoisted(() => ({
  selectLlmProvider: vi.fn<() => ModelProviderConfig | undefined>(),
  buildLlmHistory: vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([])),
}));

vi.mock("@/lib/wechat-backend", () => ({
  wechatBackend: {
    send: (id: string, token: string, text: string) => backends.wechat(id, token, text),
    sendTyping: (id: string, token: string, typing: boolean) => backends.wechatTyping(id, token, typing),
  },
}));
vi.mock("@/lib/dingtalk-backend", () => ({ dingtalkBackend: { send: (id: string, text: string) => backends.dingtalk(id, text) } }));
vi.mock("@/lib/feishu-backend", () => ({ feishuBackend: { send: (id: string, text: string) => backends.feishu(id, text) } }));
vi.mock("@/lib/telegram-backend", () => ({ telegramBackend: { send: (id: string, text: string) => backends.telegram(id, text) } }));
vi.mock("@/lib/qq-backend", () => ({ qqBackend: { send: (id: string, text: string) => backends.qq(id, text) } }));
vi.mock("@/lib/discord-backend", () => ({ discordBackend: { send: (id: string, text: string) => backends.discord(id, text) } }));
vi.mock("@/lib/wecom-backend", () => ({ wecomBackend: { send: (id: string, text: string) => backends.wecom(id, text) } }));
// ACP 路径不在本文件测试范围；提供一个最小 agent store 让 import 解析即可。
vi.mock("@/stores/agent", () => ({
  useAgentStore: () => ({ agentProviders: [], selectedProviderId: null, acpBusy: false, acpConnecting: false }),
}));
vi.mock("@/stores/chat-llm", () => ({
  selectLlmProvider: (...args: unknown[]) => chatLlm.selectLlmProvider(...(args as [])),
  buildLlmHistory: (...args: unknown[]) => chatLlm.buildLlmHistory(...(args as [])),
}));

import { createPipelineSlice, type PipelineApi } from "@/stores/remote-assistant/pipeline";
import type { StatusApi } from "@/stores/remote-assistant/status";
import type { PeersApi } from "@/stores/remote-assistant/peers";

// ---- 可控 LLM client：捕获监听器，测试内手动喂 delta/done。 ----
interface LlmHarness {
  client: LlmClient;
  chat: Mock<(params: LlmChatParams) => Promise<number>>;
  stop: Mock<(id: number) => Promise<void>>;
  available: boolean;
  emit(event: LlmEventEnvelope): void;
  lastToken(): string | undefined;
}
function createLlmHarness(): LlmHarness {
  let listener: ((event: LlmEventEnvelope) => void) | null = null;
  let lastParams: LlmChatParams | null = null;
  const chat: Mock<(params: LlmChatParams) => Promise<number>> = vi.fn((params: LlmChatParams) => {
    lastParams = params;
    return Promise.resolve(1);
  });
  const stop: Mock<(id: number) => Promise<void>> = vi.fn((_id: number) => Promise.resolve());
  const harness: LlmHarness = {
    available: true,
    chat,
    stop,
    client: {
      isAvailable: () => harness.available,
      chat: (params) => chat(params),
      stop: (id) => stop(id),
      onEvent: (fn) => {
        listener = fn;
        return Promise.resolve(() => {});
      },
    },
    emit: (event) => listener?.(event),
    lastToken: () => lastParams?.clientToken,
  };
  return harness;
}

// ---- 可控 peers：内存会话消息表 + 档案。 ----
interface PeersHarness {
  api: PeersApi;
  addPeer(peer: RemotePeer): void;
  messages(sessionId: string): ThreadMessage[];
}
function createPeersHarness(): PeersHarness {
  const peers: RemotePeer[] = [];
  const sessions = new Map<string, ThreadMessage[]>();
  let seq = 0;
  const key = (p: { channel: string; id: string }) => `${p.channel}:${p.id}`;
  const api: PeersApi = {
    persistPeers: vi.fn(),
    peerByKey: (k) => peers.find((p) => key(p) === k),
    peerList: { value: peers } as unknown as PeersApi["peerList"],
    markPeerRead: vi.fn(),
    peerSessionId: (peer) => {
      const found = peers.find((p) => key(p) === key(peer));
      const target = found ?? peer;
      if (!target.sessionId) target.sessionId = `ses-${key(target)}`;
      if (!found) peers.push(target);
      if (!sessions.has(target.sessionId)) sessions.set(target.sessionId, []);
      return target.sessionId;
    },
    appendRemoteMessage: (sessionId, role, content) => {
      const message: ThreadMessage = { id: `m-${++seq}`, role, content, ts: seq };
      const list = sessions.get(sessionId) ?? [];
      list.push(message);
      sessions.set(sessionId, list);
      return message;
    },
    updateRemoteMessage: (sessionId, messageId, content) => {
      const message = sessions.get(sessionId)?.find((m) => m.id === messageId);
      if (message) message.content = content;
    },
    readMessageContent: (sessionId, messageId) => sessions.get(sessionId)?.find((m) => m.id === messageId)?.content ?? "",
  };
  return {
    api,
    addPeer: (peer) => {
      peers.push(peer);
      if (peer.sessionId) sessions.set(peer.sessionId, []);
    },
    messages: (sessionId) => sessions.get(sessionId) ?? [],
  };
}

// ---- 可控 status：连接态可配置，活动流可断言。 ----
interface StatusHarness {
  api: StatusApi;
  connected: Set<RemoteChannel>;
  activity: { direction: string; channel: string; text: string; kind: string }[];
}
function createStatusHarness(): StatusHarness {
  const connected = new Set<RemoteChannel>();
  const activity: StatusHarness["activity"] = [];
  const api = {
    connectedOf: (channel: RemoteChannel) => connected.has(channel),
    recordActivity: (entry: { direction: string; channel: string; text: string; kind: string }) => {
      activity.push({ direction: entry.direction, channel: entry.channel, text: entry.text, kind: entry.kind });
    },
  } as unknown as StatusApi;
  return { api, connected, activity };
}

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    id: "p1",
    label: "Local",
    enabled: true,
    baseUrl: "http://localhost:1234",
    model: "test-model",
    apiKeyEnv: "",
    reasoningEffort: "auto",
    headers: {},
    ...overrides,
  } as ModelProviderConfig;
}

interface ChannelPrefsFixture {
  autoConnect: boolean;
  autoReply: boolean;
  allowOtherSenders: boolean;
}

function channelPrefs(): ChannelPrefsFixture {
  return { autoConnect: true, autoReply: true, allowOtherSenders: false };
}

interface Harness {
  pipeline: PipelineApi;
  llm: LlmHarness;
  peers: PeersHarness;
  status: StatusHarness;
  settings: {
    remoteAssist: { replyMode: string; channels: Record<string, ChannelPrefsFixture> };
    modelProviders: unknown[];
    selectedModelProviderId: string | null;
  };
}

function build(): Harness {
  const llm = createLlmHarness();
  const peers = createPeersHarness();
  const status = createStatusHarness();
  const remoteAssist = {
    replyMode: "llm" as const,
    replyProviderId: null,
    acpConfigValues: {},
    channels: {
      wechat: channelPrefs(),
      dingtalk: channelPrefs(),
      feishu: channelPrefs(),
      telegram: channelPrefs(),
      qq: channelPrefs(),
      discord: channelPrefs(),
      wecom: channelPrefs(),
    },
  };
  const settings = { remoteAssist, modelProviders: [provider()], selectedModelProviderId: "p1" };
  const state = {
    settings,
    session: { ensure: (id: string) => ({ id, messages: [] }) },
    llm: llm.client,
  } as never;
  const pipeline = createPipelineSlice({ state, getStatus: () => status.api, getPeers: () => peers.api });
  return { pipeline, llm, peers, status, settings };
}

/** 驱动一轮 LLM 回合：等 chat 被排队调用后，喂增量与完成事件。 */
async function driveLlmTurn(h: Harness, delta: string): Promise<void> {
  await vi.waitFor(() => expect(h.llm.chat).toHaveBeenCalled());
  const token = h.llm.lastToken();
  h.llm.emit({ kind: "llm-delta", payload: { clientToken: token, delta } });
  h.llm.emit({ kind: "llm-done", payload: { clientToken: token } });
}

beforeEach(() => {
  Object.values(backends).forEach((fn) => fn.mockClear());
  chatLlm.selectLlmProvider.mockReset();
  chatLlm.selectLlmProvider.mockImplementation(() => provider());
  chatLlm.buildLlmHistory.mockReset();
  chatLlm.buildLlmHistory.mockImplementation(() => Promise.resolve([]));
});

describe("入站路由 → 自动回复门禁", () => {
  it("autoReply 开：文本入站跑 LLM 回合并把纯文本经原通道回发", async () => {
    const h = build();
    h.pipeline.onDingTalkInbound({ peerId: "u1", nick: "阿甲", text: "在吗", msgType: "text", at: 100 } as never);
    await driveLlmTurn(h, "**你好**");
    await vi.waitFor(() => expect(backends.dingtalk).toHaveBeenCalled());
    // 通道回发的是纯文本（markdown 星号被抹平）
    expect(backends.dingtalk).toHaveBeenCalledWith("u1", "你好");
    // 会话里落了 user + assistant 两条（assistant 存原始 markdown）
    const msgs = h.peers.messages("ses-dingtalk:u1");
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].content).toBe("**你好**");
  });

  it("autoReply 关：入站只记录活动，不触发任何回发", async () => {
    const h = build();
    h.settings.remoteAssist.channels.dingtalk.autoReply = false;
    h.pipeline.onDingTalkInbound({ peerId: "u1", nick: "阿甲", text: "在吗", msgType: "text", at: 100 } as never);
    // 入站活动被记
    expect(h.status.activity.some((a) => a.direction === "in" && a.channel === "dingtalk")).toBe(true);
    // 给异步队列一个流转机会后，仍无回发、无 LLM 调用
    await Promise.resolve();
    await Promise.resolve();
    expect(h.llm.chat).not.toHaveBeenCalled();
    expect(backends.dingtalk).not.toHaveBeenCalled();
  });

  it("非文本入站：记 unsupported 活动，回一句「只认文字」而不喂模型", async () => {
    const h = build();
    h.pipeline.onDingTalkInbound({ peerId: "u1", nick: "阿甲", text: "", msgType: "picture", at: 100 } as never);
    await vi.waitFor(() => expect(backends.dingtalk).toHaveBeenCalled());
    expect(backends.dingtalk).toHaveBeenCalledWith("u1", t("remoteAssist.wechat.unsupportedReply"));
    expect(h.llm.chat).not.toHaveBeenCalled();
    expect(h.status.activity.some((a) => a.kind === "unsupported")).toBe(true);
  });
});

describe("LLM 回合边界", () => {
  it("无可用供应商：把「未配置」说明经通道告知对方", async () => {
    const h = build();
    chatLlm.selectLlmProvider.mockReturnValue(undefined);
    h.pipeline.onTelegramInbound({ peerId: "tg1", nick: "T", text: "hi", at: 1 } as never);
    await vi.waitFor(() => expect(backends.telegram).toHaveBeenCalled());
    expect(backends.telegram).toHaveBeenCalledWith("tg1", t("remoteAssist.wechat.noProvider"));
    expect(h.llm.chat).not.toHaveBeenCalled();
  });

  it("空回复：回发兜底文案而非空串", async () => {
    const h = build();
    h.pipeline.onQqInbound({ peerId: "q1", nick: "Q", text: "hi", at: 1 } as never);
    await driveLlmTurn(h, ""); // 模型没吐字
    await vi.waitFor(() => expect(backends.qq).toHaveBeenCalled());
    expect(backends.qq).toHaveBeenCalledWith("q1", t("remoteAssist.wechat.emptyReply"));
  });
});

describe("sendFromDesktop 分支", () => {
  it("空草稿 → emptyDraft", async () => {
    const h = build();
    expect(await h.pipeline.sendFromDesktop("dingtalk:u1", "   ")).toEqual({ ok: false, error: t("remoteAssist.conversation.emptyDraft") });
  });

  it("未知联系人 → unknownPeer", async () => {
    const h = build();
    expect(await h.pipeline.sendFromDesktop("dingtalk:ghost", "hi")).toEqual({
      ok: false,
      error: t("remoteAssist.conversation.unknownPeer"),
    });
  });

  it("通道离线 → offlineHint", async () => {
    const h = build();
    h.peers.addPeer({
      channel: "dingtalk",
      id: "u1",
      nick: "甲",
      sessionId: "ses-1",
      contextToken: null,
      lastAt: 0,
      lastText: "",
      readAt: 0,
    });
    expect(await h.pipeline.sendFromDesktop("dingtalk:u1", "hi")).toEqual({ ok: false, error: t("remoteAssist.conversation.offlineHint") });
  });

  it("微信缺 contextToken → noContextToken", async () => {
    const h = build();
    h.status.connected.add("wechat");
    h.peers.addPeer({
      channel: "wechat",
      id: "w1",
      nick: "微",
      sessionId: "ses-w",
      contextToken: null,
      lastAt: 0,
      lastText: "",
      readAt: 0,
    });
    expect(await h.pipeline.sendFromDesktop("wechat:w1", "hi")).toEqual({
      ok: false,
      error: t("remoteAssist.conversation.noContextToken"),
    });
  });

  it("正常发送 → 经通道回发、更新联系人、ok:true", async () => {
    const h = build();
    h.status.connected.add("dingtalk");
    h.peers.addPeer({
      channel: "dingtalk",
      id: "u1",
      nick: "甲",
      sessionId: "ses-1",
      contextToken: null,
      lastAt: 0,
      lastText: "",
      readAt: 0,
    });
    const result = await h.pipeline.sendFromDesktop("dingtalk:u1", "  手发一条  ");
    expect(result).toEqual({ ok: true });
    expect(backends.dingtalk).toHaveBeenCalledWith("u1", "手发一条");
    const peer = h.peers.api.peerByKey("dingtalk:u1")!;
    expect(peer.lastText).toBe("手发一条");
    expect(peer.readAt).toBe(peer.lastAt); // 手发即已读
  });

  it("通道抛错 → ok:false 带详情并记 error 活动", async () => {
    const h = build();
    h.status.connected.add("dingtalk");
    h.peers.addPeer({
      channel: "dingtalk",
      id: "u1",
      nick: "甲",
      sessionId: "ses-1",
      contextToken: null,
      lastAt: 0,
      lastText: "",
      readAt: 0,
    });
    backends.dingtalk.mockRejectedValueOnce(new Error("网络断了"));
    const result = await h.pipeline.sendFromDesktop("dingtalk:u1", "hi");
    expect(result).toEqual({ ok: false, error: "网络断了" });
    expect(h.status.activity.some((a) => a.kind === "error" && a.text === "网络断了")).toBe(true);
  });
});

describe("通道回发路由", () => {
  it("微信回发必须带 contextToken", async () => {
    const h = build();
    h.status.connected.add("wechat");
    h.peers.addPeer({
      channel: "wechat",
      id: "w1",
      nick: "微",
      sessionId: "ses-w",
      contextToken: "ctx-9",
      lastAt: 0,
      lastText: "",
      readAt: 0,
    });
    await h.pipeline.sendFromDesktop("wechat:w1", "hi");
    expect(backends.wechat).toHaveBeenCalledWith("w1", "ctx-9", "hi");
  });
});
