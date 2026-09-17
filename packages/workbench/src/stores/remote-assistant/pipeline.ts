/**
 * 回复管线切片：入站 → 本机助手（LLM 流 / ACP 回合二选一）→ 经原通道回发。
 *
 * 这是全 store 最「垂直」的一块：入站 handler 把三条通道差异收敛成一个 InboundMessage，
 * 串行队列保证同一时间只跑一轮回复，deliver 负责公共收尾（失败说明 / 空回复兜底 / 回发）。
 *
 * 依赖 status 切片（通道连接态、活动流）与 peers 切片（联系人档案、会话落消息），
 * 经 getStatus / getPeers 惰性访问；切片私有的活跃流状态（activeToken / replyBuffer /
 * settleTurn / queue）留在本文件闭包。
 */
import type { LlmChatParams } from "@greywork/llm";
import type { AgentProviderConfig } from "@greywork/shell";
import type { ThreadMessage } from "../../types";
import { dingtalkBackend, type DingTalkInbound } from "../../lib/dingtalk-backend";
import { feishuBackend, type FeishuInbound } from "../../lib/feishu-backend";
import { wechatBackend, type WechatInbound } from "../../lib/wechat-backend";
import { markdownToPlainText } from "../../lib/wechat-text";
import { useAgentStore } from "../agent";
import { buildLlmHistory, selectLlmProvider } from "../chat-llm";
import { aid, delay, describeError, peerKey, peerLabel, REPLY_FUSE_MS, t, type InboundMessage, type RemotePeer } from "./shared";
import type { RemoteAssistantState } from "./state";
import type { StatusApi } from "./status";
import type { PeersApi } from "./peers";

export interface PipelineDeps {
  state: RemoteAssistantState;
  getStatus: () => StatusApi;
  getPeers: () => PeersApi;
}

export interface PipelineApi {
  onWechatInbound(message: WechatInbound): void;
  onDingTalkInbound(message: DingTalkInbound): void;
  onFeishuInbound(message: FeishuInbound): void;
  sendFromDesktop(key: string, text: string): Promise<{ ok: boolean; error?: string }>;
}

export function createPipelineSlice({ state, getStatus, getPeers }: PipelineDeps): PipelineApi {
  const settings = state.settings;
  const sessionStore = state.session;

  /* ===== 串行队列：同一时间只跑一轮回复，避免两条消息的回合交错写进同一会话。 ===== */

  let queue: Promise<void> = Promise.resolve();

  function enqueue(task: () => Promise<void>): void {
    queue = queue.then(task).catch((error: unknown) => {
      console.error("[remote-assistant] 队列任务失败", error);
    });
  }

  /* ===== 入站 → 档案 → 排队回复 ===== */

  /** 记录一条入站并刷新联系人档案（回发凭据随消息更新）。 */
  function ingestInbound(message: InboundMessage): RemotePeer {
    const key = peerKey({ channel: message.channel, id: message.peerId });
    const description = message.text.trim() || t("remoteAssist.wechat.unsupported", { types: message.unsupportedLabel });
    const existing = getPeers().peerByKey(key);
    if (existing) {
      existing.contextToken = message.contextToken || existing.contextToken;
      existing.lastAt = message.at;
      existing.lastText = description;
      if (message.nick) existing.nick = message.nick;
      getPeers().peerSessionId(existing);
      getPeers().persistPeers();
      return existing;
    }
    const created: RemotePeer = {
      channel: message.channel,
      id: message.peerId,
      nick: message.nick || peerLabel(message.peerId),
      sessionId: "",
      contextToken: message.contextToken || null,
      lastAt: message.at,
      lastText: description,
      readAt: 0,
    };
    getPeers().peerSessionId(created);
    getPeers().persistPeers();
    return getPeers().peerByKey(key) as RemotePeer;
  }

  function handleInbound(message: InboundMessage): void {
    const peer = ingestInbound(message);
    if (!message.text.trim()) {
      getStatus().recordActivity({
        direction: "in",
        peer: peer.nick,
        channel: message.channel,
        text: t("remoteAssist.wechat.unsupported", { types: message.unsupportedLabel }),
        kind: "unsupported",
      });
    } else {
      getStatus().recordActivity({ direction: "in", peer: peer.nick, channel: message.channel, text: message.text, kind: "text" });
    }
    if (!settings.remoteAssist.channels[message.channel].autoReply) return;
    enqueue(() => replyTo(peer, message));
  }

  function onWechatInbound(message: WechatInbound): void {
    handleInbound({
      channel: "wechat",
      peerId: message.fromUserId,
      nick: "",
      text: message.text,
      contextToken: message.contextToken,
      unsupportedLabel: message.itemTypes.join("/") || "?",
      at: message.at,
    });
  }

  function onDingTalkInbound(message: DingTalkInbound): void {
    // 钉钉的非文本消息（picture / audio）也走同一条入站路径，只是文本为空 → 回一句只认文字。
    const isText = message.msgType === null || message.msgType === "text";
    handleInbound({
      channel: "dingtalk",
      peerId: message.peerId,
      nick: message.nick,
      text: isText ? message.text : "",
      contextToken: null,
      unsupportedLabel: message.msgType ?? "?",
      at: message.at,
    });
  }

  function onFeishuInbound(message: FeishuInbound): void {
    // 同钉钉：非文本消息也走同一路径，只是文本为空 → 回一句只认文字。
    const isText = message.messageType === null || message.messageType === "text";
    handleInbound({
      channel: "feishu",
      peerId: message.peerId,
      nick: message.nick,
      text: isText ? message.text : "",
      contextToken: null,
      unsupportedLabel: message.messageType ?? "?",
      at: message.at,
    });
  }

  /* ===== LLM 管线（replyMode = llm） ===== */

  /** 一轮回复的产物：正文 + 失败说明；ACP 回合附支架（正文已流进支架，会话里无需再追加一条）。 */
  type TurnResult = { text: string; error: string | null; assistantMessage?: ThreadMessage };

  /* LLM 流：只认自己那一笔（clientToken），并把这轮的增量攒起来。 */
  let activeToken: string | null = null;
  let replyBuffer = "";
  let settleTurn: ((error: string | null) => void) | null = null;
  let llmListening = false;

  function finishTurn(error: string | null): void {
    const settle = settleTurn;
    settleTurn = null;
    activeToken = null;
    settle?.(error);
  }

  async function ensureLlmListener(): Promise<void> {
    if (llmListening) return;
    llmListening = true;
    await state.llm.onEvent((event) => {
      if (!activeToken || event.payload.clientToken !== activeToken) return;
      if (event.kind === "llm-delta") replyBuffer += event.payload.delta ?? "";
      else if (event.kind === "llm-done") finishTurn(null);
      else finishTurn(event.payload.message ?? "unknown");
    });
  }

  /** 跑一轮真实 LLM 流并返回完整文本；失败/超时经 error 返回给调用方记录。 */
  async function runLlmTurn(params: LlmChatParams): Promise<{ text: string; error: string | null }> {
    replyBuffer = "";
    activeToken = aid();
    const gate = Promise.withResolvers<string | null>();
    settleTurn = gate.resolve;
    let requestId: number | null = null;
    const timer = setTimeout(() => {
      // 超时不只是放弃等待：把宿主侧那条流也停掉，别让它在后台继续烧 token。
      if (requestId !== null) void state.llm.stop(requestId).catch(() => undefined);
      if (settleTurn) finishTurn(t("remoteAssist.wechat.replyTimeout"));
    }, REPLY_FUSE_MS);
    try {
      requestId = await state.llm.chat({ ...params, clientToken: activeToken ?? undefined });
      const error = await gate.promise;
      return { text: replyBuffer, error };
    } catch (error) {
      finishTurn(describeError(error));
      return { text: replyBuffer, error: describeError(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ===== ACP 管线（replyMode = acp） ===== */

  /** 本轮该用哪个 ACP 后端：设置里指定优先，否则跟随对话页当前选择。 */
  function resolveAcpProvider(): AgentProviderConfig | undefined {
    const agent = useAgentStore();
    const configured = settings.remoteAssist.replyProviderId;
    return agent.agentProviders.find((provider) => provider.id === (configured ?? agent.selectedProviderId));
  }

  /** 等 ACP 空闲：全局只有一个 ACP 会话，对话页的回合要先跑完（超时即放弃本轮）。 */
  async function waitForAcpIdle(timeoutMs: number): Promise<boolean> {
    const agent = useAgentStore();
    const deadline = Date.now() + timeoutMs;
    while (agent.acpBusy || agent.acpConnecting) {
      if (Date.now() >= deadline) return false;
      await delay(500);
    }
    return true;
  }

  /**
   * 跑一轮 ACP 回合：把用户消息与支架入到联系人会话里，
   * 回合结束（prompt-done / prompt 层异常）后读支架正文为终稿。
   */
  async function runAcpTurn(sessionId: string, text: string, providerName: string): Promise<TurnResult> {
    const agent = useAgentStore();
    const scaffold = getPeers().appendRemoteMessage(sessionId, "assistant", "");
    const gate = Promise.withResolvers<string | null>();
    let settled = false;
    const finish = (error: string | null): void => {
      if (settled) return;
      settled = true;
      gate.resolve(error);
    };
    const timer = setTimeout(() => finish(t("remoteAssist.wechat.replyTimeout")), REPLY_FUSE_MS);

    try {
      // 检查与调用之间没有 await：宿主侧「忙则静默早退」的窗口因此不存在。
      if (agent.acpBusy || agent.acpConnecting) {
        finish(t("remoteAssist.wechat.acpBusy"));
      } else {
        await agent.sendGlobalTurn(text, providerName, {
          reuseScaffold: { threadId: sessionId, message: scaffold },
          hooks: {
            onPromptDone: () => finish(null),
            onPromptError: () => {
              finish(null);
              return true; // 错误文案已由 ACP 支架自己写入，不再叠加默认提示
            },
          },
        });
      }
      const error = await gate.promise;
      return { text: getPeers().readMessageContent(sessionId, scaffold.id), error, assistantMessage: scaffold };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ===== 回发 ===== */

  /** 按通道回发一条文本：微信带 context_token；钉钉由宿主用自己记的 sessionWebhook 发送。 */
  async function sendViaChannel(peer: RemotePeer, text: string): Promise<void> {
    if (peer.channel === "wechat") {
      const token = peer.contextToken;
      if (!token) throw new Error(t("remoteAssist.conversation.noContextToken"));
      await wechatBackend.send(peer.id, token, text);
    } else if (peer.channel === "dingtalk") {
      await dingtalkBackend.send(peer.id, text);
    } else {
      await feishuBackend.send(peer.id, text);
    }
    getStatus().recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text, kind: "text" });
  }

  /** 桌面端在会话页手发一条（不经模型）：能否发取决于通道连接态与回发凭据。 */
  async function sendFromDesktop(key: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: t("remoteAssist.conversation.emptyDraft") };
    const peer = getPeers().peerByKey(key);
    if (!peer) return { ok: false, error: t("remoteAssist.conversation.unknownPeer") };
    if (!getStatus().connectedOf(peer.channel)) return { ok: false, error: t("remoteAssist.conversation.offlineHint") };
    if (peer.channel === "wechat" && !peer.contextToken) {
      return { ok: false, error: t("remoteAssist.conversation.noContextToken") };
    }
    getPeers().appendRemoteMessage(peer.sessionId, "assistant", trimmed);
    try {
      await sendViaChannel(peer, trimmed);
    } catch (error) {
      const detail = describeError(error);
      getStatus().recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text: detail, kind: "error" });
      return { ok: false, error: detail };
    }
    peer.lastText = trimmed;
    peer.lastAt = Date.now();
    peer.readAt = peer.lastAt;
    getPeers().persistPeers();
    return { ok: true };
  }

  /** 「正在输入」只有微信协议支持；钉钉没有对应能力，静默跳过。 */
  async function signalTyping(peer: RemotePeer, typing: boolean): Promise<void> {
    if (peer.channel !== "wechat" || !peer.contextToken) return;
    await wechatBackend.sendTyping(peer.id, peer.contextToken, typing).catch(() => undefined);
  }

  /** 一轮回复的公共收尾：失败说明、空回复兜底、经原通道回发。 */
  async function deliver(peer: RemotePeer, sessionId: string, result: TurnResult): Promise<void> {
    await signalTyping(peer, false);
    if (result.error !== null && !result.text) {
      // 失败也要让对方知道原因（本机配置问题、超时、agent 忙），不能只是本机静默记一笔。
      const detail = result.error;
      if (result.assistantMessage) {
        getPeers().updateRemoteMessage(sessionId, result.assistantMessage.id, t("remoteAssist.wechat.replyFailed", { detail }));
      } else {
        getPeers().appendRemoteMessage(sessionId, "assistant", t("remoteAssist.wechat.replyFailed", { detail }));
      }
      getStatus().recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text: detail, kind: "error" });
      await sendViaChannel(peer, detail).catch(() => undefined);
      return;
    }
    const plain = markdownToPlainText(result.text).trim() || t("remoteAssist.wechat.emptyReply");
    // 会话里存原文（本地可读 Markdown），通道里发纯文本（聊天窗不渲染标记）。
    // ACP 回合的正文已流进支架、会话里已有这条回复，只回发、不重复追加。
    if (!result.assistantMessage) getPeers().appendRemoteMessage(sessionId, "assistant", result.text);
    try {
      await sendViaChannel(peer, plain);
    } catch (error) {
      getStatus().recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text: describeError(error), kind: "error" });
    }
  }

  async function replyTo(peer: RemotePeer, message: InboundMessage): Promise<void> {
    const sessionId = getPeers().peerSessionId(peer);
    if (!message.text.trim()) {
      // 非文本消息不喂模型：先如实告诉对方这一版只认文字。
      const notice = t("remoteAssist.wechat.unsupportedReply");
      getPeers().appendRemoteMessage(sessionId, "user", notice);
      await sendViaChannel(peer, notice).catch((error: unknown) => {
        getStatus().recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text: describeError(error), kind: "error" });
      });
      return;
    }

    getPeers().appendRemoteMessage(sessionId, "user", message.text);
    await signalTyping(peer, true);

    if (settings.remoteAssist.replyMode === "acp") {
      const agent = useAgentStore();
      const provider = resolveAcpProvider();
      if (!provider) {
        await deliver(peer, sessionId, { text: "", error: t("remoteAssist.wechat.noAcpProvider") });
        return;
      }
      // 远程回合与对话页共用同一台 agent：设置里指定的后端在这里生效（含对话页的选择）。
      if (provider.id !== agent.selectedProviderId) agent.selectProvider(provider.id);
      if (!(await waitForAcpIdle(REPLY_FUSE_MS))) {
        await deliver(peer, sessionId, { text: "", error: t("remoteAssist.wechat.acpBusy") });
        return;
      }
      const turn = await runAcpTurn(sessionId, message.text, provider.name);
      await deliver(peer, sessionId, turn);
      return;
    }

    await ensureLlmListener();
    const provider = selectLlmProvider(settings.modelProviders, settings.selectedModelProviderId);
    if (!provider || !state.llm.isAvailable()) {
      const reason = t("remoteAssist.wechat.noProvider");
      getPeers().appendRemoteMessage(sessionId, "assistant", reason);
      getStatus().recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text: reason, kind: "error" });
      await sendViaChannel(peer, reason).catch(() => undefined);
      return;
    }

    const history = await buildLlmHistory(sessionStore.ensure(sessionId));
    const turn = await runLlmTurn({
      baseUrl: provider.baseUrl ?? "",
      model: provider.model,
      apiKeyEnv: provider.apiKeyEnv,
      messages: history,
      reasoningEffort: provider.reasoningEffort ?? "auto",
    });
    await deliver(peer, sessionId, turn);
  }

  return {
    onWechatInbound,
    onDingTalkInbound,
    onFeishuInbound,
    sendFromDesktop,
  };
}
