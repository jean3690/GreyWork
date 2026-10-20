/**
 * 意图派发的唯一分流点：把一段文字（+ 已落库的附件）交给正确的后端。
 *
 * 这一段「发给谁」的知识原本在对话页、引导页各写一遍（引导页那份没有计划门），
 * 提问卡再抄第三遍 —— 三条路径各自演化就会出现「同一个意图在两个入口行为不同」。
 * 收在这里之后，新增后端（或新增一道门）只改这一处。
 *
 * 附件落库（materializeAttachments，需要先知道会话 id）刻意留在调用方：
 * 对话页用当前会话、引导页要先建会话，这是调用方的会话职责，不是派发职责。
 */
import { useAgentStore } from "../stores/agent";
import { useChatStore } from "../stores/chat";
import { useRunsStore } from "../stores/runs";
import { useSettingsStore } from "../stores/settings";
import type { Attachment, MessageComment } from "../types";

export interface DispatchIntentOptions {
  /** 计划模式先挂计划卡，确认后才真正派发（只有对话页有这道门）。 */
  planGate?: boolean;
  /** 允许编排判定：纯文本命中编排意图则交给 planner 拆解，不进本会话消息流。 */
  allowOrchestrate?: boolean;
  /** 选区评论：挂到本次消息上并随引用拼进提示词。 */
  comments?: readonly MessageComment[];
}

export async function dispatchIntent(
  text: string,
  attachments: readonly Attachment[] = [],
  options: DispatchIntentOptions = {},
): Promise<void> {
  const agent = useAgentStore();
  const chat = useChatStore();
  const settings = useSettingsStore();

  const comments = options.comments ?? [];

  if (agent.routeToAcp) {
    if (options.planGate && settings.planMode) agent.beginAcpPlan(text, attachments, comments);
    else await agent.dispatchToAcp(text, attachments, comments);
    return;
  }

  // 编排只吃纯文本：planner 拆解出的子任务各建独立会话，附件与评论的指代都无法随行。
  if (options.allowOrchestrate && attachments.length === 0 && comments.length === 0 && useRunsStore().maybeOrchestrate(text)) return;

  chat.submitText(text, [...attachments], comments);
}
