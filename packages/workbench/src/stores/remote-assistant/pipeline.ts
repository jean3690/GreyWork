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
import { basename } from "@greywork/core";
import type { Attachment, ChannelMediaCapability, MediaRef, ThreadMessage } from "../../types";
import { dingtalkBackend, type DingTalkInbound } from "../../lib/dingtalk-backend";
import { feishuBackend, type FeishuInbound } from "../../lib/feishu-backend";
import { discordBackend, type DiscordInbound } from "../../lib/discord-backend";
import { qqBackend, type QqInbound } from "../../lib/qq-backend";
import { telegramBackend, type TelegramInbound } from "../../lib/telegram-backend";
import { wecomBackend, type WecomInbound } from "../../lib/wecom-backend";
import { wechatBackend, type WechatInbound } from "../../lib/wechat-backend";
import { channelMediaAllows, channelMediaBackend } from "../../lib/channel-media";
import { markdownToPlainText } from "../../lib/wechat-text";
import { attachmentKind, createAttachment } from "../../lib/attachments";
import { materializeAttachments } from "../../state/attachment-library";
import { parseSendFences, stripSendFences } from "../../lib/send-fence";
import { ensureRemoteWorkspaceFolder } from "../../lib/remote-workspace";
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
  onTelegramInbound(message: TelegramInbound): void;
  onQqInbound(message: QqInbound): void;
  onDiscordInbound(message: DiscordInbound): void;
  onWecomInbound(message: WecomInbound): void;
  sendFromDesktop(key: string, text: string, attachments?: readonly Attachment[]): Promise<{ ok: boolean; error?: string }>;
}

/**
 * 远程回合的宿主能力提示（```sendfile 围栏协议）：模型据此知道「对方不在本机」，
 * 以及要把文件交出来该怎么表达。中文字面量直发、不进 i18n —— 与 SCHEDULE_HINT 同款。
 *
 * 按通道的媒体能力分叉：能力不支持出站文件的通道（钉钉 / 企业微信）必须如实告知，
 * 否则模型会一直输出围栏、宿主一直拒发，双方都以为对方有问题。
 */
const REMOTE_SEND_HINT_HEAD = "【宿主能力提示 · 远程文件发送】你正在通过聊天通道与用户对话：用户**不在本机**，看不到你的工作区与磁盘。";

/** 未指定通道时的默认能力：可发任意类别（按「能发文件」生成提示）。 */
const FULL_MEDIA_CAPABILITY: ChannelMediaCapability = {
  inbound: ["image", "video", "audio", "file"],
  outbound: ["image", "video", "audio", "file"],
};

function remoteSendHint(cap: ChannelMediaCapability): string {
  if (cap.outbound.length === 0) {
    return [
      REMOTE_SEND_HINT_HEAD,
      "这条通道**只能收文件、不能发文件**。用户要求「把某个文件发给我」时，直接说明这条通道发不了文件（建议改用其他通道），**不要**输出任何围栏，也不要回答「文件已在本机、无需发送」。",
    ].join("\n");
  }
  if (!cap.outbound.includes("file")) {
    return [
      REMOTE_SEND_HINT_HEAD,
      "这条通道**只能发送图片**，发不了文件。用户要图片时，把图片放进工作区后在回复最末尾输出一个 ```sendfile 围栏（内容是图片绝对路径的 JSON 数组）：",
      '```sendfile\n["/绝对/路径/截图.png"]\n```',
      "用户要文件时，直接说明这条通道发不了文件、建议改用其他通道，**不要**输出围栏。用户没有要求发文件时，绝对不要输出该围栏。",
    ].join("\n");
  }
  return [
    REMOTE_SEND_HINT_HEAD,
    "用户要求「把某个文件发给我」时，**不要**回答「文件已在本机、无需发送」。正确做法是：把该文件放进你的工作区目录（若它已在工作区内则不必移动），然后在回复的**最末尾**输出一个 ```sendfile 代码围栏，内容为要发送文件的**绝对路径**组成的 JSON 数组，例如：",
    '```sendfile\n["/绝对/路径/报告.xlsx"]\n```',
    "规则：只输出一个围栏；路径必须是绝对路径，且落在工作区或用户已授权的目录内（否则宿主会拒发）；单个文件不超过 20MB；用户没有要求发文件时，绝对不要输出该围栏。",
  ].join("\n");
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

  /** 入站媒体在活动流 / 档案里的短标签（单条给具体类型，多条只报数量）。 */
  function mediaLabel(refs: readonly MediaRef[]): string {
    const [only] = refs;
    if (refs.length === 1 && only) {
      return only.kind === "image" ? t("remoteAssist.media.imageInbound") : t("remoteAssist.media.fileInbound", { name: only.name });
    }
    return t("remoteAssist.media.inbound", { count: refs.length });
  }

  /** 记录一条入站并刷新联系人档案（回发凭据随消息更新）。 */
  function ingestInbound(message: InboundMessage): RemotePeer {
    const key = peerKey({ channel: message.channel, id: message.peerId });
    const media = message.mediaRefs ?? [];
    const description =
      message.text.trim() || (media.length ? mediaLabel(media) : t("remoteAssist.wechat.unsupported", { types: message.unsupportedLabel }));
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
    const media = message.mediaRefs ?? [];
    if (message.text.trim()) {
      getStatus().recordActivity({ direction: "in", peer: peer.nick, channel: message.channel, text: message.text, kind: "text" });
    } else if (media.length) {
      getStatus().recordActivity({ direction: "in", peer: peer.nick, channel: message.channel, text: mediaLabel(media), kind: "media" });
    } else {
      getStatus().recordActivity({
        direction: "in",
        peer: peer.nick,
        channel: message.channel,
        text: t("remoteAssist.wechat.unsupported", { types: message.unsupportedLabel }),
        kind: "unsupported",
      });
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
      mediaRefs: message.media ?? [],
      at: message.at,
    });
  }

  function onDingTalkInbound(message: DingTalkInbound): void {
    // 钉钉的非文本消息（picture / audio）也走同一条入站路径：图片落成 mediaRefs，
    // 其余（audio 等）文本为空 → 回一句只认文字。
    const isText = message.msgType === null || message.msgType === "text";
    handleInbound({
      channel: "dingtalk",
      peerId: message.peerId,
      nick: message.nick,
      text: isText ? message.text : "",
      contextToken: null,
      unsupportedLabel: message.msgType ?? "?",
      mediaRefs: message.media ?? [],
      at: message.at,
    });
  }

  function onFeishuInbound(message: FeishuInbound): void {
    // 同钉钉：非文本消息也走同一路径，图片 / 文件落成 mediaRefs，其余文本为空。
    const isText = message.messageType === null || message.messageType === "text";
    handleInbound({
      channel: "feishu",
      peerId: message.peerId,
      nick: message.nick,
      text: isText ? message.text : "",
      contextToken: null,
      unsupportedLabel: message.messageType ?? "?",
      mediaRefs: message.media ?? [],
      at: message.at,
    });
  }

  function onTelegramInbound(message: TelegramInbound): void {
    // 图片 / 文件 / 语音落成 mediaRefs；纯贴纸等没有可下载内容的仍只有空文本。
    handleInbound({
      channel: "telegram",
      peerId: message.peerId,
      nick: message.nick,
      text: message.text,
      contextToken: null,
      unsupportedLabel: "non-text",
      mediaRefs: message.media ?? [],
      at: message.at,
    });
  }

  function onDiscordInbound(message: DiscordInbound): void {
    handleInbound({
      channel: "discord",
      peerId: message.peerId,
      nick: message.nick,
      text: message.text,
      contextToken: null,
      unsupportedLabel: "non-text",
      mediaRefs: message.media ?? [],
      at: message.at,
    });
  }

  function onQqInbound(message: QqInbound): void {
    handleInbound({
      channel: "qq",
      peerId: message.peerId,
      nick: message.nick,
      text: message.text,
      contextToken: null,
      unsupportedLabel: "non-text",
      mediaRefs: message.media ?? [],
      at: message.at,
    });
  }

  function onWecomInbound(message: WecomInbound): void {
    // 非文本消息（图片 / 文件 / 语音）也走同一路径：图片 / 文件落成 mediaRefs。
    handleInbound({
      channel: "wecom",
      peerId: message.peerId,
      nick: message.nick,
      text: message.text,
      contextToken: null,
      unsupportedLabel: message.unsupported || "non-text",
      mediaRefs: message.media ?? [],
      at: message.at,
    });
  }

  /* ===== LLM 管线（replyMode = llm） ===== */

  /**
   * 一轮回复的产物：正文 + 失败说明；ACP 回合附支架（正文已流进支架，会话里无需再追加一条）
   * 与 `artifacts`（本回合要回传给对方的文件绝对路径）。
   */
  type TurnResult = { text: string; error: string | null; assistantMessage?: ThreadMessage; artifacts?: string[] };

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
   * 把远程助手自己的细粒度配置覆盖（模型 / 思考强度 / 会话模式）应用到当前 ACP 会话。
   *
   * 只下发 agent 此刻真的暴露了的选项：换了后端或换了模型，旧键自然失效，
   * 不猜测、不报错——「配了一个这个后端没有的模型」不该让整轮回复失败。
   */
  async function applyRemoteAcpConfig(): Promise<string | null> {
    const agent = useAgentStore();
    const overrides = settings.remoteAssist.acpConfigValues;
    for (const [configId, value] of Object.entries(overrides)) {
      const option = agent.acpConfigOptions.find((entry) => entry.id === configId && entry.type === "select");
      if (!option || String(option.currentValue ?? "") === value) continue;
      const failure = await agent.setAcpConfig(configId, value);
      if (failure) return failure;
    }
    return null;
  }

  /**
   * 跑一轮 ACP 回合：把用户消息与支架入到联系人会话里，
   * 回合结束（prompt-done / prompt 层异常）后读支架正文为终稿。
   *
   * `attachments` 是入站媒体落库后的附件（图片 / 文件）；`reuseScaffold` 只跳过 user 与
   * 支架的入流，附件照样经 `toAcpUnits` 进 prompt。
   *
   * 回传文件有两个来源，合并去重：模型在 ```sendfile 围栏里点名的（剥掉围栏后回写正文），
   * 以及宿主扫到的本回合工作区产物（经 `onPromptDone` 的 `ctx.files` 递出）。
   *
   * `hostHint` 按该通道的媒体能力生成（见 `remoteSendHint`）：能力不支持的通道要提前
   * 告诉模型发不了，否则它会一直输出围栏。
   */
  async function runAcpTurn(
    sessionId: string,
    text: string,
    providerName: string,
    attachments: readonly Attachment[] = [],
    hostHint: string = remoteSendHint(FULL_MEDIA_CAPABILITY),
  ): Promise<TurnResult> {
    const agent = useAgentStore();
    const scaffold = getPeers().appendRemoteMessage(sessionId, "assistant", "");
    const gate = Promise.withResolvers<string | null>();
    let settled = false;
    let artifacts: string[] = [];
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
          attachments,
          hostHint,
          hooks: {
            onPromptDone: (ctx) => {
              artifacts = ctx.files ?? [];
              finish(null);
            },
            onPromptError: () => {
              finish(null);
              return true; // 错误文案已由 ACP 支架自己写入，不再叠加默认提示
            },
          },
        });
      }
      const error = await gate.promise;
      const raw = getPeers().readMessageContent(sessionId, scaffold.id);
      const requested = parseSendFences(raw);
      // 围栏是给宿主看的指令，不该留在会话存档里，也不该发给对方。
      const content = requested.length ? stripSendFences(raw) : raw;
      if (requested.length) getPeers().updateRemoteMessage(sessionId, scaffold.id, content);
      return {
        text: content,
        error,
        assistantMessage: scaffold,
        artifacts: [...artifacts, ...requested.filter((path) => !artifacts.includes(path))],
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ===== 回发 ===== */

  /**
   * 按通道回发一条文本：微信带 context_token；其余由宿主用自己记的凭据发送。
   *
   * `contextToken` 显式传入本次要回复的那条入站消息的 token（默认取 peer 上最新的一条）。
   * 微信的 token 是**每条消息**的回信凭据，复用旧 token 会被服务端静默丢弃：自动回复必须
   * 带回「正在答复的那条」的 token，而不是发信时读 peer 上被后到消息覆盖过的最新值。
   */
  async function sendViaChannel(peer: RemotePeer, text: string, contextToken: string | null = peer.contextToken): Promise<void> {
    if (peer.channel === "wechat") {
      const token = contextToken;
      if (!token) throw new Error(t("remoteAssist.conversation.noContextToken"));
      await wechatBackend.send(peer.id, token, text);
    } else if (peer.channel === "dingtalk") {
      await dingtalkBackend.send(peer.id, text);
    } else if (peer.channel === "feishu") {
      await feishuBackend.send(peer.id, text);
    } else if (peer.channel === "telegram") {
      await telegramBackend.send(peer.id, text);
    } else if (peer.channel === "qq") {
      await qqBackend.send(peer.id, text);
    } else if (peer.channel === "discord") {
      await discordBackend.send(peer.id, text);
    } else {
      await wecomBackend.send(peer.id, text);
    }
    getStatus().recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text, kind: "text" });
  }

  /* ===== 出站媒体 ===== */

  /** 按文件名猜媒体类型：图片走 image 端点，其余（含 md / csv 等文本产物）走 file 端点。 */
  function mediaKindOfName(name: string): "image" | "file" {
    return attachmentKind(name, "") === "image" ? "image" : "file";
  }

  /** 能力不允许时的说明文案（宿主侧另有一份兜底，这里负责界面可读）。 */
  function capabilityMessage(cap: ChannelMediaCapability): string {
    if (cap.outbound.length === 0) {
      return cap.inbound.length ? t("remoteAssist.conversation.mediaInboundOnly") : t("remoteAssist.conversation.mediaUnsupported");
    }
    if (!cap.outbound.includes("file")) return t("remoteAssist.conversation.mediaImageOnly");
    // 能发文件时不该走到这里；留一条通用文案兜住「声明与实际不一致」的极端情况。
    return t("remoteAssist.conversation.mediaUnsupported");
  }

  /**
   * 按通道回发一条媒体：先过能力矩阵（协议事实），再交给通用命令分发到该通道的上传实现。
   *
   * 微信的 `context_token` 按条颁发，必须原样带回被回复那条的 token；其余通道的凭据由宿主
   * 自己记着，不传。
   */
  async function sendMediaViaChannel(
    peer: RemotePeer,
    path: string,
    kind: "image" | "file",
    contextToken: string | null = peer.contextToken,
  ): Promise<void> {
    const cap = state.mediaCapabilities.value[peer.channel];
    if (!channelMediaAllows(cap, kind)) throw new Error(capabilityMessage(cap));
    if (peer.channel === "wechat" && !contextToken) {
      throw new Error(t("remoteAssist.conversation.noContextToken"));
    }
    await channelMediaBackend.sendMedia(
      peer.channel,
      peer.id,
      path,
      kind,
      peer.channel === "wechat" ? (contextToken ?? undefined) : undefined,
    );
  }

  /**
   * 逐条回发媒体文件；单条失败只记活动流，不阻断后续 —— 附件是「附加动作」，
   * 一个坏文件不该把已经排好的其余文件一起拖下水。
   *
   * 通道发不了的类型（钉钉不能发、企业微信发不了文件）在这里整体挡下并记一笔，
   * 而不是逐条报错刷屏。
   */
  async function relayMedia(
    peer: RemotePeer,
    items: readonly { path: string; name: string; kind: "image" | "file" }[],
    contextToken: string | null = peer.contextToken,
  ): Promise<void> {
    if (!items.length) return;
    const cap = state.mediaCapabilities.value[peer.channel];
    const sendable = items.filter((item) => channelMediaAllows(cap, item.kind));
    if (sendable.length < items.length) {
      getStatus().recordActivity({
        direction: "out",
        peer: peer.nick,
        channel: peer.channel,
        text: capabilityMessage(cap),
        kind: "error",
      });
    }
    for (const item of sendable) {
      try {
        await sendMediaViaChannel(peer, item.path, item.kind, contextToken);
        getStatus().recordActivity({
          direction: "out",
          peer: peer.nick,
          channel: peer.channel,
          text: t("remoteAssist.media.artifactSent", { name: item.name }),
          kind: "media",
        });
      } catch (error) {
        getStatus().recordActivity({
          direction: "out",
          peer: peer.nick,
          channel: peer.channel,
          text: t("remoteAssist.media.sendFailed", { name: item.name, detail: describeError(error) }),
          kind: "error",
        });
      }
    }
  }

  /**
   * 桌面端在会话页手发一条（不经模型）：能否发取决于通道连接态与回发凭据。
   * 允许「只有附件没有文字」——发个文件过去本身就是完整意图。
   */
  async function sendFromDesktop(
    key: string,
    text: string,
    attachments: readonly Attachment[] = [],
  ): Promise<{ ok: boolean; error?: string }> {
    const trimmed = text.trim();
    if (!trimmed && !attachments.length) return { ok: false, error: t("remoteAssist.conversation.emptyDraft") };
    const peer = getPeers().peerByKey(key);
    if (!peer) return { ok: false, error: t("remoteAssist.conversation.unknownPeer") };
    if (!getStatus().connectedOf(peer.channel)) return { ok: false, error: t("remoteAssist.conversation.offlineHint") };
    if (peer.channel === "wechat" && !peer.contextToken) {
      return { ok: false, error: t("remoteAssist.conversation.noContextToken") };
    }
    const media = mediaOf(peer, attachments);
    // 能力不允许就整条拒掉：别先把附件写进会话存档（界面显示"已发出"）再悄悄发不出去。
    const cap = state.mediaCapabilities.value[peer.channel];
    const blocked = media.find((item) => !channelMediaAllows(cap, item.kind));
    if (blocked) return { ok: false, error: capabilityMessage(cap) };
    const sessionId = peer.sessionId || getPeers().peerSessionId(peer);
    getPeers().appendRemoteMessage(sessionId, "assistant", trimmed, attachments);
    if (trimmed) {
      try {
        await sendViaChannel(peer, trimmed);
      } catch (error) {
        const detail = describeError(error);
        getStatus().recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text: detail, kind: "error" });
        return { ok: false, error: detail };
      }
    }
    await relayMedia(peer, media);
    peer.lastText = trimmed || attachments.map((item) => item.name).join("、");
    peer.lastAt = Date.now();
    peer.readAt = peer.lastAt;
    getPeers().persistPeers();
    return { ok: true };
  }

  /** 附件 → 可回发的媒体项；没有 path（落库失败的降级态）的条目直接丢掉并记一笔。 */
  function mediaOf(peer: RemotePeer, items: readonly Attachment[]): { path: string; name: string; kind: "image" | "file" }[] {
    const out: { path: string; name: string; kind: "image" | "file" }[] = [];
    for (const item of items) {
      if (item.path) {
        out.push({ path: item.path, name: item.name, kind: item.kind === "image" ? "image" : "file" });
        continue;
      }
      getStatus().recordActivity({
        direction: "out",
        peer: peer.nick,
        channel: peer.channel,
        text: t("remoteAssist.media.sendFailed", { name: item.name, detail: t("remoteAssist.conversation.mediaNoPath") }),
        kind: "error",
      });
    }
    return out;
  }

  /**
   * 「正在输入」只有微信协议支持；其余通道没有对应能力，静默跳过。
   * 回信凭据由宿主（SDK）自己记着，这里不必再带 context_token；取消是宿主侧 no-op。
   */
  async function signalTyping(peer: RemotePeer, typing: boolean): Promise<void> {
    if (peer.channel !== "wechat") return;
    await wechatBackend.sendTyping(peer.id, typing).catch(() => undefined);
  }

  /** 一轮回复的公共收尾：失败说明、空回复兜底、经原通道回发（微信带本轮消息的 context_token）。 */
  async function deliver(
    peer: RemotePeer,
    sessionId: string,
    result: TurnResult,
    contextToken: string | null = peer.contextToken,
  ): Promise<void> {
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
      await sendViaChannel(peer, detail, contextToken).catch(() => undefined);
      return;
    }
    const plain = markdownToPlainText(result.text).trim() || t("remoteAssist.wechat.emptyReply");
    // 会话里存原文（本地可读 Markdown），通道里发纯文本（聊天窗不渲染标记）。
    // ACP 回合的正文已流进支架、会话里已有这条回复，只回发、不重复追加。
    if (!result.assistantMessage) getPeers().appendRemoteMessage(sessionId, "assistant", result.text);
    try {
      await sendViaChannel(peer, plain, contextToken);
    } catch (error) {
      getStatus().recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text: describeError(error), kind: "error" });
    }
  }

  /**
   * 把入站媒体从宿主 inbox 取进会话附件库。
   *
   * 宿主只给路径（字节留在 `<应用数据>/<通道>/inbox`，渲染端读不到）：逐条 take
   * （取走即删）→ 交 `materializeAttachments` 落到 `~/.greyWork/attachments/<会话id>/`。
   * 单条失败只记活动流、不中断整轮 —— 文字部分照常喂模型。
   */
  async function takeInboundMedia(peer: RemotePeer, sessionId: string, refs: readonly MediaRef[]): Promise<Attachment[]> {
    if (!refs.length) return [];
    const drafts: Attachment[] = [];
    for (const ref of refs) {
      try {
        const bytes = await channelMediaBackend.takeMedia(peer.channel, ref.path);
        drafts.push(createAttachment({ kind: ref.kind, name: ref.name, mime: ref.mime, size: bytes.length, bytes }));
      } catch (error) {
        getStatus().recordActivity({
          direction: "in",
          peer: peer.nick,
          channel: peer.channel,
          text: t("remoteAssist.media.takeFailed", { name: ref.name, detail: describeError(error) }),
          kind: "error",
        });
      }
    }
    // 落库失败（磁盘满 / 无权限）的条目没有 path，留在消息里只会变成一个点不开的 chip。
    return (await materializeAttachments(sessionId, drafts)).filter((item) => item.path);
  }

  async function replyTo(peer: RemotePeer, message: InboundMessage): Promise<void> {
    const sessionId = getPeers().peerSessionId(peer);
    // 本轮要回复的那条消息自己的 context_token（微信按条颁发，用错会被静默丢弃）。
    // 冻结在回合开始处：LLM / ACP 出字要时间，期间后到的消息会把 peer.contextToken 覆盖成新值，
    // 发信时再读 peer 就会拿错 token —— 这正是「第一条能回、后面回不了」的根因。
    const replyToken = message.contextToken || peer.contextToken;
    const attachments = await takeInboundMedia(peer, sessionId, message.mediaRefs ?? []);
    if (!message.text.trim() && !attachments.length) {
      // 既没文字也没拿到媒体（或本来就不是媒体）：如实告诉对方这一版认不了这条消息。
      const notice = t("remoteAssist.wechat.unsupportedReply");
      getPeers().appendRemoteMessage(sessionId, "user", notice);
      await sendViaChannel(peer, notice, replyToken).catch((error: unknown) => {
        getStatus().recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text: describeError(error), kind: "error" });
      });
      return;
    }

    getPeers().appendRemoteMessage(sessionId, "user", message.text, attachments);
    await signalTyping(peer, true);

    // 本回合要回传的文件（围栏点名 + 工作区产物），文字送达后逐条回传；
    // 通道发不了的类型由 relayMedia 按能力矩阵挡下。
    let artifacts: string[] = [];
    try {
      if (settings.remoteAssist.replyMode === "acp") {
        const agent = useAgentStore();
        const provider = resolveAcpProvider();
        if (!provider) {
          await deliver(peer, sessionId, { text: "", error: t("remoteAssist.wechat.noAcpProvider") }, replyToken);
          return;
        }
        // 远程回合与对话页共用同一台 agent：设置里指定的后端在这里生效（含对话页的选择）。
        if (provider.id !== agent.selectedProviderId) agent.selectProvider(provider.id);
        if (!(await waitForAcpIdle(REPLY_FUSE_MS))) {
          await deliver(peer, sessionId, { text: "", error: t("remoteAssist.wechat.acpBusy") }, replyToken);
          return;
        }
        // 首次远程回合也要确保 cwd 已绑定到「远程助手」工作区；已绑定时立即返回。
        await ensureRemoteWorkspaceFolder(state.workspace).catch((error: unknown) => {
          console.warn("[remote-assistant] 远程工作区文件夹未就绪", error);
        });
        // 细粒度覆盖（模型 / 思考强度 / 会话模式）在本轮开始前落定：远程消息的答复
        // 不该被对话页临时切过的模型影响——那是「这台机器怎么回消息」的固定设置。
        const configFailure = await applyRemoteAcpConfig();
        if (configFailure) {
          await deliver(peer, sessionId, { text: "", error: configFailure }, replyToken);
          return;
        }
        const turn = await runAcpTurn(
          sessionId,
          message.text,
          provider.name,
          attachments,
          remoteSendHint(state.mediaCapabilities.value[peer.channel]),
        );
        artifacts = turn.artifacts ?? [];
        await deliver(peer, sessionId, turn, replyToken);
        return;
      }

      await ensureLlmListener();
      const provider = selectLlmProvider(settings.modelProviders, settings.selectedModelProviderId);
      if (!provider || !state.llm.isAvailable()) {
        const reason = t("remoteAssist.wechat.noProvider");
        getPeers().appendRemoteMessage(sessionId, "assistant", reason);
        getStatus().recordActivity({ direction: "out", peer: peer.nick, channel: peer.channel, text: reason, kind: "error" });
        await sendViaChannel(peer, reason, replyToken).catch(() => undefined);
        return;
      }

      const history = await buildLlmHistory(sessionStore.ensure(sessionId));
      const turn = await runLlmTurn({
        baseUrl: provider.baseUrl ?? "",
        model: provider.model,
        apiKeyEnv: provider.apiKeyEnv,
        messages: history,
        reasoningEffort: provider.reasoningEffort ?? "auto",
        headers: provider.headers,
      });
      await deliver(peer, sessionId, turn, replyToken);
    } finally {
      // 文字先送达，文件随后逐条回传（仅微信能发媒体，其余通道记 error）。
      await relayMedia(
        peer,
        artifacts.map((path) => ({ path, name: basename(path), kind: mediaKindOfName(basename(path)) })),
        replyToken,
      );
    }
  }

  return {
    onWechatInbound,
    onDingTalkInbound,
    onFeishuInbound,
    onTelegramInbound,
    onQqInbound,
    onDiscordInbound,
    onWecomInbound,
    sendFromDesktop,
  };
}
