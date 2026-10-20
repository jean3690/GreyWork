/**
 * send→respond 管线切片（ChatView 共用）：
 * user 消息入流 → planMode 时挂起 plan 卡（inline）→ 确认后执行。
 * ACP 支架入流（startAcpTurn，agent store 派发）也在此，返回 { threadId, message }
 * 供宿主事件按线程流式续写（不依赖 activeThreadId）。
 */
import { buildSteps, uid } from "./shared";
import { buildCommentPrompt } from "../../lib/message-comments";
import type { AskAnswer, Attachment, MessageComment, ThreadMessage } from "../../types";
import type { ChatStoreState } from "./state";
import type { SessionApi } from "./session";
import type { StreamApi } from "./stream";

export interface SubmitDeps {
  state: ChatStoreState;
  getSession: () => SessionApi;
  getStream: () => StreamApi;
}

export interface SubmitApi {
  submitText(text: string, attachments?: Attachment[], comments?: readonly MessageComment[]): ThreadMessage | null;
  submitTextIn(threadId: string, text: string): ThreadMessage | null;
  confirmPlan(_threadId: string, message: ThreadMessage): void;
  cancelPlan(threadId: string, message: ThreadMessage): void;
  markAskAnswered(threadId: string, message: ThreadMessage, answers: AskAnswer[]): void;
  /** 自动化任务提案已创建：写回 createdId，卡片转只读（回放不重复建）。 */
  markScheduleCreated(threadId: string, message: ThreadMessage, createdId: string): void;
  /** 用户不需要这条自动化任务提案：从消息上摘掉草稿。 */
  clearScheduleDraft(threadId: string, message: ThreadMessage): void;
  startAcpTurn(
    text: string,
    providerName: string,
    attachments?: Attachment[],
    comments?: readonly MessageComment[],
    /** 指定入流线程（自动化任务专属会话）；缺省走当前激活线程。 */
    threadId?: string,
  ): { threadId: string; message: ThreadMessage; userMessage: ThreadMessage };
}

export function createSubmitSlice({ state, getSession, getStream }: SubmitDeps): SubmitApi {
  const session = getSession();
  const { busy, sessionStore, settingsStore } = state;

  function submitText(text: string, attachments: Attachment[] = [], comments: readonly MessageComment[] = []): ThreadMessage | null {
    const trimmed = text.trim();
    // 有附件 / 评论时允许空正文（截图问答、纯批注：本身就是意图）。
    if ((!trimmed && attachments.length === 0 && comments.length === 0) || busy.value) return null;
    if (!session.activeThreadId.value) {
      session.activeThreadId.value = sessionStore.createSession(null).id;
    }
    session.push(session.activeThreadId.value, {
      id: uid(),
      role: "user",
      content: trimmed,
      ts: Date.now(),
      attachments: [...attachments],
      ...(comments.length > 0 ? { comments: [...comments] } : {}),
    });

    if (settingsStore.planMode) {
      const pending: ThreadMessage = {
        id: uid(),
        role: "assistant",
        content: "",
        ts: Date.now(),
        steps: buildSteps(trimmed),
        planPending: true,
        planDraft: trimmed,
        // 附件 / 评论留在脚手架消息上：确认时才派发，取消则随卡片一起丢弃。
        planAttachments: [...attachments],
        planComments: [...comments],
      };
      session.push(session.activeThreadId.value, pending);
      return pending;
    }
    const message: ThreadMessage = { id: uid(), role: "assistant", content: "", ts: Date.now(), steps: buildSteps(trimmed) };
    session.push(session.activeThreadId.value, message);
    // 评论引用拼进提示词：批注文本已在正文里，模型还缺「针对哪一段」。
    void getStream().dispatchAssistant(message, buildCommentPrompt(trimmed, comments));
    return message;
  }

  /**
   * 在**指定线程**里发起一轮对话，不碰 `activeThreadId`。
   *
   * 自动化任务的专属会话用这条：任务到点执行时，用户可能正停在别的会话里聊天，
   * 若走 submitText 会把指令灌进「当前会话」（旧实现就是这个毛病：一条每分钟的任务
   * 把 hello 反复塞进同一个会话）。这里还刻意跳过 planMode —— 自动化是无人值守跑的，
   * 挂一张「等你确认」的计划卡等于这一轮永远不执行。
   */
  function submitTextIn(threadId: string, text: string): ThreadMessage | null {
    const trimmed = text.trim();
    if (!trimmed || busy.value || !threadId) return null;
    session.push(threadId, { id: uid(), role: "user", content: trimmed, ts: Date.now() });
    const message: ThreadMessage = { id: uid(), role: "assistant", content: "", ts: Date.now(), steps: buildSteps(trimmed) };
    session.push(threadId, message);
    // threadId 交给流式分片：历史取该线程的，runningSessionId 也标到该线程上。
    void getStream().dispatchAssistant(message, trimmed, threadId);
    return message;
  }

  function confirmPlan(_threadId: string, message: ThreadMessage): void {
    // 计划卡存的意图文本在此交还执行管线：产物/工具识别基于用户原始输入，而非占位内容。
    // 评论引用同样在此时拼回提示词（正文里的批注文本已在 planDraft 内）。
    void getStream().dispatchAssistant(message, buildCommentPrompt(message.planDraft ?? "", message.planComments ?? []));
  }

  function cancelPlan(threadId: string, message: ThreadMessage): void {
    const list = session.ensure(threadId);
    const index = list.indexOf(message);
    if (index >= 0) list.splice(index, 1);
  }

  /**
   * AskUserQuestion 收口：把作答写到消息的 ask 载荷上（卡片随之转只读态）。
   *
   * 只负责记状态，不派发 —— 派发由调用方（AskQuestionCard）按当前后端分流，
   * 与 ConversationView.dispatchWithAttachments 走同一条路，避免两条分支各记一份。
   */
  function markAskAnswered(threadId: string, message: ThreadMessage, answers: AskAnswer[]): void {
    if (!message.ask) return;
    message.ask = { ...message.ask, answers, answeredAt: Date.now() };
    sessionStore.touch(threadId);
    sessionStore.markDirty();
  }

  function markScheduleCreated(threadId: string, message: ThreadMessage, createdId: string): void {
    if (!message.scheduleDraft) return;
    message.scheduleDraft = { ...message.scheduleDraft, createdId };
    sessionStore.touch(threadId);
    sessionStore.markDirty();
  }

  function clearScheduleDraft(threadId: string, message: ThreadMessage): void {
    if (!message.scheduleDraft) return;
    delete message.scheduleDraft;
    sessionStore.touch(threadId);
    sessionStore.markDirty();
  }

  /**
   * ACP 回合（agent store 派发）：user 消息入流 + assistant 支架，
   * 返回 { threadId, message } 供 ACP 事件按线程流式续写（不依赖 activeThreadId）。
   * 与 submitText 的差异：无 planMode / mock 步骤时间线，内容完全由 ACP 宿主事件驱动。
   *
   * 额外返回 `userMessage`：回合起点的工作区快照 ref 要记在它上面（见 agent/turn 的
   * 回合起点快照），调用方需要它的引用。
   */
  function startAcpTurn(
    text: string,
    providerName: string,
    attachments: Attachment[] = [],
    comments: readonly MessageComment[] = [],
    threadId?: string,
  ): { threadId: string; message: ThreadMessage; userMessage: ThreadMessage } {
    // 指定了线程就不读写 activeThreadId：自动化任务的专属会话不该抢走用户的焦点。
    let targetThreadId = threadId ?? "";
    if (!targetThreadId) {
      if (!session.activeThreadId.value) session.activeThreadId.value = sessionStore.createSession(null).id;
      targetThreadId = session.activeThreadId.value;
    }
    const userMessage: ThreadMessage = {
      id: uid(),
      role: "user",
      content: text,
      ts: Date.now(),
      attachments: [...attachments],
      ...(comments.length > 0 ? { comments: [...comments] } : {}),
    };
    session.push(targetThreadId, userMessage);
    const message: ThreadMessage = { id: uid(), role: "assistant", content: "", ts: Date.now(), acp: providerName };
    session.push(targetThreadId, message);
    return { threadId: targetThreadId, message, userMessage };
  }

  return { submitText, submitTextIn, confirmPlan, cancelPlan, markAskAnswered, markScheduleCreated, clearScheduleDraft, startAcpTurn };
}
