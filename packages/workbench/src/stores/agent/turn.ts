/**
 * 全局回合切片：普通对话派发（dispatchToAcp）与编排 planner（runs 域）
 * 共用的一套「支架入流 → 事件驱动续写 → prompt-done 统一收尾」机制。
 *
 * 本切片是纯会话域：不静态依赖 runs 编排域，差异经 attachRunBridge 的事件桥
 * 与 sendGlobalTurn 的 hooks 表达。只依赖 runtime 切片的 startAcpSession。
 */
import { acp } from "../../lib/acp-client";
import { buildCommentPrompt } from "../../lib/message-comments";
import { worktreeBackend } from "../../lib/worktree-backend";
import type { Attachment, MessageComment, ThreadMessage } from "../../types";
import type { RuntimeApi } from "./runtime";
import { CONNECT_ABORTED, t, toAcpUnits, type GlobalTurnOptions, type RunEventBridge } from "./shared";
import type { AgentStoreState } from "./state";

/** 编排域内部契约：全局回合派发（planner 阶段经 hooks 收尾）与事件消费桥注册。 */
export interface TurnDeps {
  state: AgentStoreState;
  getRuntime: () => RuntimeApi;
}

/**
 * 发给模型的宿主能力提示（schedule 围栏协议）：模型据此知道「可以提议定时任务」。
 * 与 cowork 的协作协议提示同构——中文字面量直发，不进 i18n；刻意不告诉模型当前时间
 * （onceAt 由模型估必错），时刻准确性由确认卡与定时任务页的编辑兜住。
 */
const SCHEDULE_HINT = [
  "【宿主能力提示 · 定时任务】如果用户在本条消息里明确要求创建定时/周期/提醒类任务，请在回复的**最末尾**输出一个 ```schedule 代码围栏，内容为一个 JSON 对象：",
  '- 周期任务：{"name":"任务名","intent":"每次触发时要执行的指令","cron":"分 时 日 月 周"}',
  '- 一次性任务：{"name":"任务名","intent":"…","onceAt":<触发时刻的 epoch 毫秒>}',
  "规则：只输出一个围栏；cron 必须是标准 5 段表达式（分 时 日 月 周）；intent 要写成独立可执行的完整指令。用户没有要求定时任务时，绝对不要输出该围栏。最终是否创建由用户在确认卡上决定。",
].join("\n");

export interface TurnApi {
  writeTurnError(messageId: string, detail: string, threadId: string): void;
  sendGlobalTurn(text: string, providerName: string, options?: GlobalTurnOptions): Promise<void>;
  dispatchToAcp(text: string, attachments?: readonly Attachment[], comments?: readonly MessageComment[]): Promise<void>;
  beginAcpPlan(text: string, attachments?: readonly Attachment[], comments?: readonly MessageComment[]): void;
  confirmAcpPlan(threadId: string, message: ThreadMessage): void;
  attachRunBridge(bridge: RunEventBridge | null): void;
  /**
   * 回退到某条**用户消息之前**：把工作区硬恢复到该消息的回合起点快照，截断消息流（丢弃该消息
   * 及其后全部），并清掉 ACP 绑定。返回错误文案（null = 成功）。
   */
  rewindTo(threadId: string, messageId: string): Promise<string | null>;
}

export function createTurnSlice({ state, getRuntime }: TurnDeps): TurnApi {
  const chat = state.chat;
  const locals = state.locals;

  /**
   * 回合失败落文案：空内容整段替换为失败行；已有流式内容则在末尾追加失败行。
   * prompt-done 带 error、planner 钩子未自写错误文案时共用——失败回合不落「无文本输出」。
   */
  function writeTurnError(messageId: string, detail: string, threadId: string): void {
    const message = chat.threads[threadId]?.find((candidate) => candidate.id === messageId);
    if (!message) return;
    const text = t("chat.llmCallFailed", { detail });
    if (!message.content.trim()) chat.setMessageContent(messageId, text, threadId);
    else {
      chat.appendMessageContent(messageId, `\n\n${text}`, threadId);
      chat.flushPendingContent();
    }
  }

  /**
   * 回合起点快照：把「这条用户消息开跑之前」的工作区状态记成一个宿主快照，ref 挂到 user 消息上，
   * 供 `rewindTo` 回退。
   *
   * 只在 worktree 运行档位、宿主可用、且该会话已绑定 cwd 时做。**失败只告警不阻断**：快照是回退
   * 能力的锦上添花，不该让一个回合因此发不出去。非 git 隔离快照（copy/direct）宿主会直接报错，
   * 这里按「本回合无快照」处理（该消息不可回退）。
   */
  async function snapshotTurnStart(threadId: string, userMessage: ThreadMessage): Promise<void> {
    if (!worktreeBackend.active() || state.settings.runMode !== "worktree") return;
    const cwd = state.session.getSession(threadId)?.acp?.cwd;
    if (!cwd) return;
    try {
      userMessage.snapshotRef = await worktreeBackend.snapshot(cwd);
      state.session.markDirty();
    } catch (error) {
      console.warn("[agent] 回合起点快照失败，本条消息不可回退", error);
    }
  }

  /** 线程里紧邻 `message` 之前的 user 消息（计划门复用支架时用它找回回合起点）。 */
  function precedingUserMessage(threadId: string, message: ThreadMessage): ThreadMessage | null {
    const list = chat.threads[threadId];
    if (!list) return null;
    const index = list.findIndex((candidate) => candidate.id === message.id);
    if (index <= 0) return null;
    const previous = list[index - 1];
    return previous?.role === "user" ? previous : null;
  }

  /**
   * 全局回合统一入口（普通对话派发与编排 planner 共用）：支架消息先入当前线程，
   * 宿主事件（chunk / 权限 / 停止）驱动支架流式续写，回合终局（prompt-done / prompt 层异常）统一收尾。
   *
   * `reuseGlobalSession: true` 时信任调用方已 connectAcp（planner 路径与旧 dispatchRun 一致：
   * 先 connect 后建回合，不做「会话是否属于本线程」的隔离检查）；默认做隔离检查。
   */
  async function sendGlobalTurn(text: string, providerName: string, options: GlobalTurnOptions = {}): Promise<void> {
    if (state.acpBusy.value || state.acpConnecting.value) return;
    let threadId: string;
    let message: ThreadMessage;
    let userMessage: ThreadMessage | null;
    if (options.reuseScaffold) {
      // 计划门确认：user 消息与支架已在挂卡时入流，直接复用，避免重复入流。
      threadId = options.reuseScaffold.threadId;
      message = options.reuseScaffold.message;
      // 复用路径没有 startAcpTurn 的返回值：向前找紧邻的 user 消息（回合起点快照挂在它上面）。
      userMessage = precedingUserMessage(threadId, message);
    } else {
      ({ threadId, message, userMessage } = chat.startAcpTurn(
        text,
        providerName,
        [...(options.attachments ?? [])],
        options.comments ?? [],
      ));
    }
    locals.acpStream = message;
    locals.acpThreadId = threadId;
    state.acpStreamId.value = message.id;
    // 会话隔离：没有进程/会话，或现有会话属于**另一条对话** → 都要建新会话（进程照旧复用）。
    if (
      !options.reuseGlobalSession &&
      (state.acpHandle.value === null || state.acpSessionId.value === null || locals.acpSessionThreadId !== threadId)
    ) {
      const failure = await getRuntime().startAcpSession(threadId);
      if (failure) {
        if (failure === CONNECT_ABORTED) {
          // 用户在连接期点了停止：按「回合已停止」收尾，别当错误报。
          chat.appendMessageContent(message.id, `\n\n${t("chat.stopped")}`, locals.acpThreadId);
          chat.flushPendingContent();
        } else {
          chat.setMessageContent(message.id, t("errors.acpStartFailed", { detail: failure }), locals.acpThreadId);
        }
        locals.acpStream = null;
        locals.acpThreadId = null;
        state.acpStreamId.value = null;
        return;
      }
    }
    state.acpBusy.value = true;
    state.turnStartedAtMs.value = Date.now();
    // 回合归属钉到会话上：侧栏据此把「运行中」显示在正确的那一行（busy 是全局锁，说不清是谁）。
    chat.runningSessionId = threadId;
    if (!options.hooks?.preserveThought) state.acpThoughtText.value = "";
    if (options.hooks) locals.turnHooks = options.hooks;
    try {
      const units = await toAcpUnits(options.attachments ?? [], state.acpImageSupport.value !== false);
      // schedule 围栏说明每会话只注入一次（ACP 会话跨回合保留上下文，每回合都注入
      // 纯属浪费且提高幻觉概率）。编排回合（planner 输出会被 parsePlan 整体解析）
      // 不注入：往结构化输出里混围栏会污染解析。
      // 选区评论的引用先拼到正文前（批注文本已是 text 的一部分），再叠加各类宿主提示。
      let promptText = buildCommentPrompt(text, options.comments ?? []);
      const sessionId = state.acpSessionId.value;
      if (!options.hooks && sessionId && locals.scheduleHintInjectedFor !== sessionId) {
        locals.scheduleHintInjectedFor = sessionId;
        promptText = `${SCHEDULE_HINT}\n\n${promptText}`;
      }
      // 调用方宿主能力提示（远程文件发送）：hooks 存在时也要注入——远程回合走的就是 hooked 分支。
      if (options.hostHint && sessionId && locals.hostHintInjectedFor !== sessionId) {
        locals.hostHintInjectedFor = sessionId;
        promptText = `${options.hostHint}\n\n${promptText}`;
      }
      // 回合起点快照：把「这条用户消息开跑之前」的工作区状态记下来（仅普通用户回合、
      // worktree 档位；planner/hooked 回合不是用户回合，不记）。必须在 acp.prompt 之前 ——
      // 之后 agent 就开始改文件，快照就不再是「跑之前」的状态了。
      if (!options.hooks && userMessage) await snapshotTurnStart(threadId, userMessage);
      const { turnId } = await acp.prompt(state.acpHandle.value as number, promptText, units);
      state.activeTurnId.value = turnId;
      // 注意：成功后不清 acpStream —— prompt 只是 ack，回合增量经事件异步回流，支架必须活到 prompt-done / stopped。
    } catch (error) {
      state.activeTurnId.value = null;
      state.turnStartedAtMs.value = null;
      locals.turnHooks = null;
      // 钩子先决：编排路径自行落错误文案并返回 true，跳过默认 [ACP 派发失败]。
      if (options.hooks?.onPromptError?.({ threadId, messageId: message.id, error }) !== true) {
        const detail = error instanceof Error ? error.message : String(error);
        const current = locals.acpThreadId ? chat.threads[locals.acpThreadId]?.find((candidate) => candidate.id === message.id) : undefined;
        chat.setMessageContent(
          message.id,
          current?.content ? `${current.content}\n\n${t("errors.dispatchFailed", { detail })}` : t("errors.dispatchFailed", { detail }),
          locals.acpThreadId,
        );
      }
      locals.acpStream = null;
      locals.acpThreadId = null;
      state.acpStreamId.value = null;
      state.acpBusy.value = false;
      chat.runningSessionId = null;
    }
  }

  /** 派发意图到选中 ACP 后端（普通对话路径：默认带会话隔离与默认错误文案）。 */
  async function dispatchToAcp(
    text: string,
    attachments: readonly Attachment[] = [],
    comments: readonly MessageComment[] = [],
  ): Promise<void> {
    const providerName = state.agentProviders.value.find((provider) => provider.id === state.selectedProviderId.value)?.name ?? "ACP";
    await sendGlobalTurn(text, providerName, { attachments, comments });
  }

  /**
   * 计划模式 · ACP 门：先入流 user + 支架并挂起计划卡（planPending），确认前不派发、不建会话。
   * 确认走 confirmAcpPlan 复用同一支架；取消只需 chat.cancelPlan 摘掉卡片。
   */
  function beginAcpPlan(text: string, attachments: readonly Attachment[] = [], comments: readonly MessageComment[] = []): void {
    const providerName = state.agentProviders.value.find((provider) => provider.id === state.selectedProviderId.value)?.name ?? "ACP";
    const { message } = chat.startAcpTurn(text, providerName, [...attachments], comments);
    message.planDraft = text;
    message.planAttachments = [...attachments];
    message.planComments = [...comments];
    message.planPending = true;
  }

  /** 计划模式 · ACP 确认：解除计划卡并按 planDraft 派发同一支架（不重复入流）。
   * 回合运行中确认被忽略（卡片保持挂起），等当前回合结束后可再次确认。 */
  function confirmAcpPlan(threadId: string, message: ThreadMessage): void {
    const attachments = message.planAttachments ?? [];
    const comments = message.planComments ?? [];
    const text = message.planDraft ?? "";
    const providerName = message.acp;
    if (
      (!text && attachments.length === 0 && comments.length === 0) ||
      !providerName ||
      !message.planPending ||
      state.acpBusy.value ||
      state.acpConnecting.value
    )
      return;
    message.planPending = false;
    message.planDraft = undefined;
    message.planAttachments = undefined;
    message.planComments = undefined;
    void sendGlobalTurn(text, providerName, { reuseScaffold: { threadId, message }, attachments, comments });
  }

  /** 编排域（runs store）注册事件消费桥；null = 解除。 */
  function attachRunBridge(bridge: RunEventBridge | null): void {
    locals.runBridge = bridge;
  }

  /**
   * 回退到某条**用户消息之前**：工作区硬恢复到该消息的回合起点快照，截断消息流（丢弃该消息
   * 及其后全部，便于改后重发），并清掉 ACP 绑定。返回错误文案（null = 成功）。
   *
   * 文件回退走 `worktree_restore`（严格等于快照：快照之后新建的文件会被删除）。agent 的上下文
   * 在服务端、ACP 没有回退接口，所以必须清绑定 + 会话归属，让下个回合开**新会话** —— 代价是
   * agent 会忘掉被丢弃的那几轮（A3 的核心限制，调用方需向用户明示）。
   */
  async function rewindTo(threadId: string, messageId: string): Promise<string | null> {
    if (state.acpBusy.value || state.acpConnecting.value) return t("chat.rewindBusy");
    const record = state.session.getSession(threadId);
    if (!record) return t("chat.rewindUnavailable");
    const index = record.messages.findIndex((candidate) => candidate.id === messageId);
    const target = index >= 0 ? record.messages[index] : undefined;
    if (!target || target.role !== "user" || !target.snapshotRef) return t("chat.rewindUnavailable");
    const cwd = record.acp?.cwd;
    if (!cwd) return t("chat.rewindUnavailable");
    try {
      await worktreeBackend.restore(cwd, target.snapshotRef);
    } catch (error) {
      return t("chat.rewindFailed", { detail: error instanceof Error ? error.message : String(error) });
    }
    // 文件已回到该消息之前：截断消息流（丢弃该 user 消息及其后全部，便于改后重发）。
    state.session.truncateMessages(threadId, index);
    // 清绑定 + 会话归属：让下个回合开新会话（agent 上下文不可回退）。
    state.session.setAcpBinding(threadId, null);
    if (locals.acpSessionThreadId === threadId) locals.acpSessionThreadId = null;
    return null;
  }

  return {
    writeTurnError,
    sendGlobalTurn,
    dispatchToAcp,
    beginAcpPlan,
    confirmAcpPlan,
    attachRunBridge,
    rewindTo,
  };
}
