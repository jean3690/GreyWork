/**
 * send→respond 管线切片（ChatView 共用）：
 * user 消息入流 → planMode 时挂起 plan 卡（inline）→ 确认后执行。
 * ACP 支架入流（startAcpTurn，agent store 派发）也在此，返回 { threadId, message }
 * 供宿主事件按线程流式续写（不依赖 activeThreadId）。
 */
import { buildSteps, uid } from "./shared";
import type { AskAnswer, Attachment, ThreadMessage } from "../../types";
import type { ChatStoreState } from "./state";
import type { SessionApi } from "./session";
import type { StreamApi } from "./stream";

export interface SubmitDeps {
  state: ChatStoreState;
  getSession: () => SessionApi;
  getStream: () => StreamApi;
}

export interface SubmitApi {
  submitText(text: string, attachments?: Attachment[]): ThreadMessage | null;
  confirmPlan(_threadId: string, message: ThreadMessage): void;
  cancelPlan(threadId: string, message: ThreadMessage): void;
  markAskAnswered(threadId: string, message: ThreadMessage, answers: AskAnswer[]): void;
  /** 定时任务提案已创建：写回 createdId，卡片转只读（回放不重复建）。 */
  markScheduleCreated(threadId: string, message: ThreadMessage, createdId: string): void;
  /** 用户不需要这条定时任务提案：从消息上摘掉草稿。 */
  clearScheduleDraft(threadId: string, message: ThreadMessage): void;
  startAcpTurn(text: string, providerName: string, attachments?: Attachment[]): { threadId: string; message: ThreadMessage };
}

export function createSubmitSlice({ state, getSession, getStream }: SubmitDeps): SubmitApi {
  const session = getSession();
  const { busy, sessionStore, settingsStore } = state;

  function submitText(text: string, attachments: Attachment[] = []): ThreadMessage | null {
    const trimmed = text.trim();
    // 有附件时允许空正文（截图问答：图本身就是意图）。
    if ((!trimmed && attachments.length === 0) || busy.value) return null;
    if (!session.activeThreadId.value) {
      session.activeThreadId.value = sessionStore.createSession(null).id;
    }
    session.push(session.activeThreadId.value, {
      id: uid(),
      role: "user",
      content: trimmed,
      ts: Date.now(),
      attachments: [...attachments],
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
        // 附件留在脚手架消息上：确认时才派发，取消则随卡片一起丢弃。
        planAttachments: [...attachments],
      };
      session.push(session.activeThreadId.value, pending);
      return pending;
    }
    const message: ThreadMessage = { id: uid(), role: "assistant", content: "", ts: Date.now(), steps: buildSteps(trimmed) };
    session.push(session.activeThreadId.value, message);
    void getStream().dispatchAssistant(message, trimmed);
    return message;
  }

  function confirmPlan(_threadId: string, message: ThreadMessage): void {
    // 计划卡存的意图文本在此交还执行管线：产物/工具识别基于用户原始输入，而非占位内容。
    void getStream().dispatchAssistant(message, message.planDraft ?? "");
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
   */
  function startAcpTurn(text: string, providerName: string, attachments: Attachment[] = []): { threadId: string; message: ThreadMessage } {
    if (!session.activeThreadId.value) session.activeThreadId.value = sessionStore.createSession(null).id;
    const threadId = session.activeThreadId.value;
    session.push(threadId, { id: uid(), role: "user", content: text, ts: Date.now(), attachments: [...attachments] });
    const message: ThreadMessage = { id: uid(), role: "assistant", content: "", ts: Date.now(), acp: providerName };
    session.push(threadId, message);
    return { threadId, message };
  }

  return { submitText, confirmPlan, cancelPlan, markAskAnswered, markScheduleCreated, clearScheduleDraft, startAcpTurn };
}
