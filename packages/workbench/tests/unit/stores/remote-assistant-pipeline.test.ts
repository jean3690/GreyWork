// 回复管线切片的可观测契约：入站路由 / 自动回复门禁 / LLM 回合交付 / 桌面手发的分支。
// 切片经 createPipelineSlice({ state, getStatus, getPeers }) 直接注入，绕开 pinia store。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LlmChatParams, LlmClient, LlmEventEnvelope } from "@greywork/llm";
import type { ModelProviderConfig } from "@greywork/shell";
import { i18n } from "@/i18n";
import type { Attachment, ThreadMessage } from "@/types";
import type { WechatInbound } from "@/lib/wechat-backend";
import type * as ChannelMedia from "@/lib/channel-media";
import type { RemoteChannel, RemotePeer } from "@/stores/remote-assistant/shared";

const t = i18n.global.t;

// 七条通道后端：只关心 send 是否被调用、带什么参数。
const backends = vi.hoisted(() => ({
  wechat: vi.fn<(id: string, token: string, text: string) => Promise<void>>(() => Promise.resolve()),
  wechatTyping: vi.fn<(id: string, typing: boolean) => Promise<void>>(() => Promise.resolve()),
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

// 入站媒体：宿主 inbox 取字节 + 落库；出站媒体：通用命令按通道分发。真实实现依赖 Tauri，这里替换掉。
const media = vi.hoisted(() => ({
  capabilities: vi.fn<() => Promise<Record<string, string>>>(),
  takeMedia: vi.fn<(channel: string, path: string) => Promise<Uint8Array>>(),
  sendMedia: vi.fn<(channel: string, peerId: string, path: string, kind?: string, token?: string) => Promise<void>>(() =>
    Promise.resolve(),
  ),
  materialize: vi.fn<(sessionId: string, items: readonly unknown[]) => Promise<unknown[]>>(),
}));

vi.mock("@/state/attachment-library", () => ({
  materializeAttachments: (sessionId: string, items: readonly unknown[]) => media.materialize(sessionId, items),
}));

vi.mock("@/lib/wechat-backend", () => ({
  wechatBackend: {
    send: (id: string, token: string, text: string) => backends.wechat(id, token, text),
    sendTyping: (id: string, typing: boolean) => backends.wechatTyping(id, typing),
  },
}));
// 通用媒体层：保留纯函数（能力判定），只把两个命令换成可断言的桩。
vi.mock("@/lib/channel-media", async (importOriginal) => {
  const actual = await importOriginal<typeof ChannelMedia>();
  return {
    ...actual,
    channelMediaBackend: {
      capabilities: () => media.capabilities(),
      takeMedia: (channel: string, path: string) => media.takeMedia(channel, path),
      sendMedia: (channel: string, peerId: string, path: string, kind?: string, token?: string) =>
        media.sendMedia(channel, peerId, path, kind, token),
    },
  };
});
vi.mock("@/lib/dingtalk-backend", () => ({ dingtalkBackend: { send: (id: string, text: string) => backends.dingtalk(id, text) } }));
vi.mock("@/lib/feishu-backend", () => ({ feishuBackend: { send: (id: string, text: string) => backends.feishu(id, text) } }));
vi.mock("@/lib/telegram-backend", () => ({ telegramBackend: { send: (id: string, text: string) => backends.telegram(id, text) } }));
vi.mock("@/lib/qq-backend", () => ({ qqBackend: { send: (id: string, text: string) => backends.qq(id, text) } }));
vi.mock("@/lib/discord-backend", () => ({ discordBackend: { send: (id: string, text: string) => backends.discord(id, text) } }));
vi.mock("@/lib/wecom-backend", () => ({ wecomBackend: { send: (id: string, text: string) => backends.wecom(id, text) } }));
// ACP 路径：远程回合经 agent store 派发，测试内用脚本驱动回合收尾（写正文 + 回调钩子）。
const agent = vi.hoisted(() => ({
  providers: [] as { id: string; name: string }[],
  selectedProviderId: null as string | null,
  sendGlobalTurn: vi.fn<(text: string, providerName: string, options?: unknown) => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("@/stores/agent", () => ({
  useAgentStore: () => ({
    agentProviders: agent.providers,
    selectedProviderId: agent.selectedProviderId,
    acpBusy: false,
    acpConnecting: false,
    acpConfigOptions: [],
    selectProvider: vi.fn(),
    setAcpConfig: vi.fn(),
    sendGlobalTurn: (text: string, providerName: string, options?: unknown) => agent.sendGlobalTurn(text, providerName, options),
  }),
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
    resetChannelSessions: vi.fn(),
    peerSessionId: (peer) => {
      const found = peers.find((p) => key(p) === key(peer));
      const target = found ?? peer;
      if (!target.sessionId) target.sessionId = `ses-${key(target)}`;
      if (!found) peers.push(target);
      if (!sessions.has(target.sessionId)) sessions.set(target.sessionId, []);
      return target.sessionId;
    },
    appendRemoteMessage: (sessionId, role, content, attachments = []) => {
      const message: ThreadMessage = {
        id: `m-${++seq}`,
        role,
        content,
        ts: seq,
        ...(attachments.length ? { attachments: [...attachments] } : {}),
      };
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
    remoteAssist: {
      replyMode: string;
      replyProviderId: string | null;
      acpConfigValues: Record<string, string>;
      channels: Record<string, ChannelPrefsFixture>;
    };
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
    // 能力矩阵与宿主 capability_of 同口径：钉钉仅接收、企微仅图片，其余双向。
    mediaCapabilities: {
      value: {
        wechat: "both",
        dingtalk: "inboundOnly",
        feishu: "both",
        telegram: "both",
        qq: "both",
        discord: "both",
        wecom: "imageOnly",
      },
    },
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

/** 把远程回复切到 ACP 模式，并让后端目录里有一个可解析的 provider。 */
function acpMode(h: Harness): void {
  h.settings.remoteAssist.replyMode = "acp";
  h.settings.remoteAssist.replyProviderId = "p1";
  agent.providers = [{ id: "p1", name: "ACP" }];
  agent.selectedProviderId = "p1";
}

interface AcpTurnScript {
  /** 回合收尾时写进支架的正文（模拟模型输出，可含 ```sendfile 围栏）。 */
  output?: string;
  /** 宿主扫到的本回合工作区产物（prompt-done 的 files）。 */
  files?: string[];
  /** 有值 = 失败回合：走 onPromptError 而非 onPromptDone。 */
  error?: string;
}

/** 按脚本驱动 ACP 回合：写正文 → 回调钩子，`runAcpTurn` 随后即可读终稿并收产物。 */
function scriptAcpTurn(h: Harness, script: AcpTurnScript): void {
  agent.sendGlobalTurn.mockImplementationOnce(async (_text: string, _providerName: string, options?: unknown): Promise<void> => {
    const opts = options as {
      reuseScaffold: { threadId: string; message: ThreadMessage };
      hooks: {
        onPromptDone?: (ctx: { threadId: string; messageId: string; files?: string[] }) => void;
        onPromptError?: (ctx: { threadId: string; messageId: string; error?: unknown }) => boolean | void;
      };
    };
    const { threadId, message } = opts.reuseScaffold;
    if (script.output !== undefined) h.peers.api.updateRemoteMessage(threadId, message.id, script.output);
    if (script.error !== undefined) opts.hooks.onPromptError?.({ threadId, messageId: message.id, error: script.error });
    else opts.hooks.onPromptDone?.({ threadId, messageId: message.id, files: script.files ?? [] });
  });
}

/** 组装一个 sendfile 围栏。 */
function sendFence(paths: string[]): string {
  return ["```sendfile", JSON.stringify(paths), "```"].join("\n");
}

function wechatInbound(text: string, contextToken = "ctx-9"): WechatInbound {
  return {
    fromUserId: "w1",
    contextToken,
    text,
    itemTypes: [1],
    media: [],
    createTimeMs: null,
    at: 100,
  };
}

beforeEach(() => {
  Object.values(backends).forEach((fn) => fn.mockClear());
  agent.providers = [];
  agent.selectedProviderId = null;
  agent.sendGlobalTurn.mockReset();
  agent.sendGlobalTurn.mockImplementation(() => Promise.resolve());
  chatLlm.selectLlmProvider.mockReset();
  chatLlm.selectLlmProvider.mockImplementation(() => provider());
  chatLlm.buildLlmHistory.mockReset();
  chatLlm.buildLlmHistory.mockImplementation(() => Promise.resolve([]));
  media.capabilities.mockReset();
  media.capabilities.mockImplementation(() => Promise.resolve({}));
  media.takeMedia.mockReset();
  media.takeMedia.mockImplementation(() => Promise.resolve(new Uint8Array([1, 2, 3])));
  media.sendMedia.mockReset();
  media.sendMedia.mockImplementation(() => Promise.resolve());
  media.materialize.mockReset();
  // 默认落库成功：给每条补一个 path，模拟「写进会话附件目录」。
  media.materialize.mockImplementation((_sessionId, items) =>
    Promise.resolve(items.map((item, index) => ({ ...(item as object), path: `/tmp/att-${index}` }))),
  );
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

describe("微信 context_token 绑定", () => {
  const inbound = (text: string, token: string, at: number): WechatInbound => ({
    fromUserId: "wx1",
    contextToken: token,
    text,
    itemTypes: [1],
    media: [],
    createTimeMs: null,
    at,
  });

  it("在途回复不被后到消息污染：每条回复各带被回复消息自己的 token", async () => {
    const h = build();
    // 第一条到达并进入 LLM 回合。
    h.pipeline.onWechatInbound(inbound("一", "ctx-A", 1));
    await vi.waitFor(() => expect(h.llm.chat).toHaveBeenCalledTimes(1));
    const tokenA = h.llm.lastToken();
    // 第一条还没回完，第二条就到了：它会把 peer.contextToken 覆盖成 ctx-B。
    h.pipeline.onWechatInbound(inbound("二", "ctx-B", 2));
    // 完成第一轮：回发必须带 ctx-A（被回复的那条），而不是被覆盖后的 ctx-B。
    h.llm.emit({ kind: "llm-delta", payload: { clientToken: tokenA, delta: "回一" } });
    h.llm.emit({ kind: "llm-done", payload: { clientToken: tokenA } });
    await vi.waitFor(() => expect(backends.wechat).toHaveBeenNthCalledWith(1, "wx1", "ctx-A", "回一"));
    // 串行队列放行第二轮，完成它：回发带 ctx-B。
    await vi.waitFor(() => expect(h.llm.chat).toHaveBeenCalledTimes(2));
    const tokenB = h.llm.lastToken();
    h.llm.emit({ kind: "llm-delta", payload: { clientToken: tokenB, delta: "回二" } });
    h.llm.emit({ kind: "llm-done", payload: { clientToken: tokenB } });
    await vi.waitFor(() => expect(backends.wechat).toHaveBeenNthCalledWith(2, "wx1", "ctx-B", "回二"));
  });
});

describe("入站媒体", () => {
  const imageRef = { kind: "image", name: "pic.png", mime: "image/png", size: 3, path: "/inbox/1-0.png" } as const;

  it("微信入站只有图片：取字节落库成附件、喂模型，不再回「只认文字」", async () => {
    const h = build();
    h.pipeline.onWechatInbound({
      fromUserId: "wx1",
      contextToken: "ctx-1",
      text: "",
      itemTypes: [2],
      media: [imageRef],
      createTimeMs: null,
      at: 100,
    });
    await driveLlmTurn(h, "看到了");
    await vi.waitFor(() => expect(backends.wechat).toHaveBeenCalled());

    expect(media.takeMedia).toHaveBeenCalledWith("wechat", "/inbox/1-0.png");
    expect(backends.wechat).toHaveBeenCalledWith("wx1", "ctx-1", "看到了");
    expect(backends.wechat).not.toHaveBeenCalledWith("wx1", "ctx-1", t("remoteAssist.wechat.unsupportedReply"));
    // 附件挂到了那条 user 消息上（后续 buildLlmHistory 就是靠它展开图片）
    expect(h.peers.messages("ses-wechat:wx1")[0].attachments?.map((item) => item.kind)).toEqual(["image"]);
    // 活动流按 media 分类，文案用图片专用标签
    expect(h.status.activity.some((a) => a.kind === "media" && a.text === t("remoteAssist.media.imageInbound"))).toBe(true);
  });

  it("媒体取字节失败且没有文字：回一句「只认文字」，并记一条 error 活动", async () => {
    const h = build();
    media.takeMedia.mockRejectedValue(new Error("收件目录不可访问"));

    h.pipeline.onWechatInbound({
      fromUserId: "wx1",
      contextToken: "ctx-1",
      text: "",
      itemTypes: [2],
      media: [imageRef],
      createTimeMs: null,
      at: 100,
    });
    await vi.waitFor(() => expect(backends.wechat).toHaveBeenCalled());

    expect(backends.wechat).toHaveBeenCalledWith("wx1", "ctx-1", t("remoteAssist.wechat.unsupportedReply"));
    expect(h.llm.chat).not.toHaveBeenCalled();
    expect(h.status.activity.some((a) => a.kind === "error" && a.text.includes("pic.png"))).toBe(true);
  });

  it("落库失败（附件没有 path）按没拿到处理，不留点不开的 chip", async () => {
    const h = build();
    media.materialize.mockResolvedValue([]);

    h.pipeline.onWechatInbound({
      fromUserId: "wx1",
      contextToken: "ctx-1",
      text: "",
      itemTypes: [4],
      media: [{ kind: "file", name: "report.pdf", mime: "application/pdf", size: 9, path: "/inbox/3-0.pdf" }],
      createTimeMs: null,
      at: 100,
    });
    await vi.waitFor(() => expect(backends.wechat).toHaveBeenCalled());

    expect(backends.wechat).toHaveBeenCalledWith("wx1", "ctx-1", t("remoteAssist.wechat.unsupportedReply"));
    expect(h.peers.messages("ses-wechat:wx1")[0].attachments).toBeUndefined();
  });

  it("图文同一条：文字照常进 prompt，媒体也挂上", async () => {
    const h = build();
    h.pipeline.onWechatInbound({
      fromUserId: "wx1",
      contextToken: "ctx-1",
      text: "看这张",
      itemTypes: [1, 2],
      media: [imageRef],
      createTimeMs: null,
      at: 100,
    });
    await driveLlmTurn(h, "好的");
    await vi.waitFor(() => expect(backends.wechat).toHaveBeenCalled());

    const first = h.peers.messages("ses-wechat:wx1")[0];
    expect(first.content).toBe("看这张");
    expect(first.attachments?.map((item) => item.name)).toEqual(["pic.png"]);
    expect(h.status.activity.some((a) => a.kind === "text" && a.text === "看这张")).toBe(true);
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

describe("出站媒体", () => {
  function wechatPeer(h: Harness): void {
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
  }

  function attachment(overrides: Partial<Attachment> = {}): Attachment {
    return { id: "att-1", kind: "file", name: "report.pdf", mime: "application/pdf", size: 9, path: "/tmp/report.pdf", ...overrides };
  }

  it("纯附件（无文字）也能发：走 sendMedia，会话里落一条带附件的消息", async () => {
    const h = build();
    wechatPeer(h);

    const result = await h.pipeline.sendFromDesktop("wechat:w1", "", [attachment()]);

    expect(result).toEqual({ ok: true });
    expect(backends.wechat).not.toHaveBeenCalled(); // 没文字就不发文本
    expect(media.sendMedia).toHaveBeenCalledWith("wechat", "w1", "/tmp/report.pdf", "file", "ctx-9");
    expect(h.peers.messages("ses-w")[0].attachments?.map((item) => item.name)).toEqual(["report.pdf"]);
    expect(h.peers.api.peerByKey("wechat:w1")?.lastText).toBe("report.pdf");
  });

  it("图片附件走 image 端点", async () => {
    const h = build();
    wechatPeer(h);

    await h.pipeline.sendFromDesktop("wechat:w1", "看", [attachment({ kind: "image", name: "pic.png", path: "/tmp/pic.png" })]);

    expect(media.sendMedia).toHaveBeenCalledWith("wechat", "w1", "/tmp/pic.png", "image", "ctx-9");
  });

  it("通道发不了附件（钉钉仅接收）：整条拒掉，文字也不发", async () => {
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

    const result = await h.pipeline.sendFromDesktop("dingtalk:u1", "给你个文件", [attachment()]);

    expect(result).toEqual({ ok: false, error: t("remoteAssist.conversation.mediaInboundOnly") });
    expect(backends.dingtalk).not.toHaveBeenCalled();
    expect(media.sendMedia).not.toHaveBeenCalled();
  });

  it("附件没有 path（落库失败）不发 sendMedia，只记 error", async () => {
    const h = build();
    wechatPeer(h);

    await h.pipeline.sendFromDesktop("wechat:w1", "看", [attachment({ path: undefined })]);

    expect(media.sendMedia).not.toHaveBeenCalled();
    expect(h.status.activity.some((a) => a.kind === "error" && a.text.includes("report.pdf"))).toBe(true);
  });

  it("回合产物落盘后回传：文字先送，产物随后（去重、仅微信）", async () => {
    const h = build();
    wechatPeer(h);
    acpMode(h);
    // 同一条路径既被围栏点名、又被宿主扫进 files：只应发一次。
    scriptAcpTurn(h, {
      output: ["做好了。", sendFence(["/disk/报表.xlsx"])].join("\n"),
      files: ["/disk/报表.xlsx"],
    });

    h.pipeline.onWechatInbound(wechatInbound("做张表"));

    await vi.waitFor(() => expect(media.sendMedia).toHaveBeenCalledTimes(1));
    expect(media.sendMedia).toHaveBeenCalledWith("wechat", "w1", "/disk/报表.xlsx", "file", "ctx-9");
    // 文字先送达，产物后回传
    expect(backends.wechat.mock.invocationCallOrder[0]).toBeLessThan(media.sendMedia.mock.invocationCallOrder[0]);
  });

  it("没有产物的回合不发媒体", async () => {
    const h = build();
    wechatPeer(h);

    h.pipeline.onWechatInbound(wechatInbound("在吗"));
    await driveLlmTurn(h, "在");
    await vi.waitFor(() => expect(backends.wechat).toHaveBeenCalled());

    expect(media.sendMedia).not.toHaveBeenCalled();
  });

  it("ACP 回合：围栏点名的文件回传，正文与会话存档里都不留围栏", async () => {
    const h = build();
    wechatPeer(h);
    acpMode(h);
    scriptAcpTurn(h, { output: ["文件给你。", sendFence(["/disk/报表.xlsx", "/disk/说明.pdf"])].join("\n") });

    h.pipeline.onWechatInbound(wechatInbound("把Excel发我"));

    await vi.waitFor(() => expect(media.sendMedia).toHaveBeenCalledTimes(2));
    expect(media.sendMedia).toHaveBeenNthCalledWith(1, "wechat", "w1", "/disk/报表.xlsx", "file", "ctx-9");
    expect(media.sendMedia).toHaveBeenNthCalledWith(2, "wechat", "w1", "/disk/说明.pdf", "file", "ctx-9");
    // 发给对方的是干净正文
    expect(backends.wechat).toHaveBeenCalledWith("w1", "ctx-9", "文件给你。");
    // 会话存档里也没有围栏（那是给宿主的指令）
    const assistant = h.peers.messages("ses-w").filter((m) => m.role === "assistant");
    expect(assistant.at(-1)?.content).toBe("文件给你。");
  });

  it("ACP 回合：宿主扫到的本回合产物按扩展名选端点（图片走 image）", async () => {
    const h = build();
    wechatPeer(h);
    acpMode(h);
    scriptAcpTurn(h, { output: "图好了", files: ["/home/u/out/chart.png", "/home/u/out/data.csv"] });

    h.pipeline.onWechatInbound(wechatInbound("出个图"));

    await vi.waitFor(() => expect(media.sendMedia).toHaveBeenCalledTimes(2));
    expect(media.sendMedia).toHaveBeenNthCalledWith(1, "wechat", "w1", "/home/u/out/chart.png", "image", "ctx-9");
    expect(media.sendMedia).toHaveBeenNthCalledWith(2, "wechat", "w1", "/home/u/out/data.csv", "file", "ctx-9");
  });

  it("ACP 回合：通道发不了产物（钉钉仅接收）只记 error 活动，不影响文字送达", async () => {
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
    h.settings.remoteAssist.replyMode = "acp";
    h.settings.remoteAssist.replyProviderId = "p1";
    agent.providers = [{ id: "p1", name: "ACP" }];
    agent.selectedProviderId = "p1";
    scriptAcpTurn(h, { output: "给你", files: ["/home/u/out/data.csv"] });

    h.pipeline.onDingTalkInbound({ msgId: null, peerId: "u1", nick: "甲", text: "发我", msgType: "text", conversationType: null, at: 100 });

    await vi.waitFor(() => expect(backends.dingtalk).toHaveBeenCalledWith("u1", "给你"));
    expect(media.sendMedia).not.toHaveBeenCalled();
    expect(h.status.activity.some((a) => a.kind === "error" && a.text === t("remoteAssist.conversation.mediaInboundOnly"))).toBe(true);
  });
});
