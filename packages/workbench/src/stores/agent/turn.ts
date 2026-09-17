/**
 * 全局回合切片：普通对话派发（dispatchToAcp）与编排 planner（runs 域）
 * 共用的一套「支架入流 → 事件驱动续写 → prompt-done 统一收尾」机制。
 *
 * 本切片是纯会话域：不静态依赖 runs 编排域，差异经 attachRunBridge 的事件桥
 * 与 sendGlobalTurn 的 hooks 表达。只依赖 runtime 切片的 startAcpSession。
 */
import { acp } from "../../lib/acp-client";
import type { Attachment, ThreadMessage } from "../../types";
import type { RuntimeApi } from "./runtime";
import { CONNECT_ABORTED, t, toAcpUnits, type GlobalTurnOptions, type RunEventBridge } from "./shared";
import type { AgentStoreState } from "./state";

/** 编排域内部契约：全局回合派发（planner 阶段经 hooks 收尾）与事件消费桥注册。 */
export interface TurnDeps {
  state: AgentStoreState;
  getRuntime: () => RuntimeApi;
}

export interface TurnApi {
  writeTurnError(messageId: string, detail: string, threadId: string): void;
  sendGlobalTurn(text: string, providerName: string, options?: GlobalTurnOptions): Promise<void>;
  dispatchToAcp(text: string, attachments?: readonly Attachment[]): Promise<void>;
  beginAcpPlan(text: string, attachments?: readonly Attachment[]): void;
  confirmAcpPlan(threadId: string, message: ThreadMessage): void;
  attachRunBridge(bridge: RunEventBridge | null): void;
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
    if (options.reuseScaffold) {
      // 计划门确认：user 消息与支架已在挂卡时入流，直接复用，避免重复入流。
      threadId = options.reuseScaffold.threadId;
      message = options.reuseScaffold.message;
    } else {
      ({ threadId, message } = chat.startAcpTurn(text, providerName, [...(options.attachments ?? [])]));
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
      const { turnId } = await acp.prompt(state.acpHandle.value as number, text, units);
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
  async function dispatchToAcp(text: string, attachments: readonly Attachment[] = []): Promise<void> {
    const providerName = state.agentProviders.value.find((provider) => provider.id === state.selectedProviderId.value)?.name ?? "ACP";
    await sendGlobalTurn(text, providerName, { attachments });
  }

  /**
   * 计划模式 · ACP 门：先入流 user + 支架并挂起计划卡（planPending），确认前不派发、不建会话。
   * 确认走 confirmAcpPlan 复用同一支架；取消只需 chat.cancelPlan 摘掉卡片。
   */
  function beginAcpPlan(text: string, attachments: readonly Attachment[] = []): void {
    const providerName = state.agentProviders.value.find((provider) => provider.id === state.selectedProviderId.value)?.name ?? "ACP";
    const { message } = chat.startAcpTurn(text, providerName, [...attachments]);
    message.planDraft = text;
    message.planAttachments = [...attachments];
    message.planPending = true;
  }

  /** 计划模式 · ACP 确认：解除计划卡并按 planDraft 派发同一支架（不重复入流）。
   * 回合运行中确认被忽略（卡片保持挂起），等当前回合结束后可再次确认。 */
  function confirmAcpPlan(threadId: string, message: ThreadMessage): void {
    const attachments = message.planAttachments ?? [];
    const text = message.planDraft ?? "";
    const providerName = message.acp;
    if ((!text && attachments.length === 0) || !providerName || !message.planPending || state.acpBusy.value || state.acpConnecting.value)
      return;
    message.planPending = false;
    message.planDraft = undefined;
    message.planAttachments = undefined;
    void sendGlobalTurn(text, providerName, { reuseScaffold: { threadId, message }, attachments });
  }

  /** 编排域（runs store）注册事件消费桥；null = 解除。 */
  function attachRunBridge(bridge: RunEventBridge | null): void {
    locals.runBridge = bridge;
  }

  return {
    writeTurnError,
    sendGlobalTurn,
    dispatchToAcp,
    beginAcpPlan,
    confirmAcpPlan,
    attachRunBridge,
  };
}
