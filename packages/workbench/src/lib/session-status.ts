/**
 * 会话四态状态：未开始（idle）/ 运行（running）/ 等待中（waiting）/ 结束（done）。
 *
 * 状态**不落盘**，一律由运行时信号派生 —— 落盘的「运行中」在崩溃后会变成永远骗人的假状态。
 * `sessionStatus` 是纯函数（可单测），`useSessionStatus()` 负责把 store 信号喂进去。
 *
 * 优先级 `waiting > running`：等待权限确认发生在 ACP 回合**进行中**（acpBusy 仍为真），
 * 若让 running 优先，「等待中」恰好在用户最需要看到它的时候永远不可达。
 */
import { useAgentStore } from "../stores/agent";
import { useChatStore } from "../stores/chat";
import { useSessionStore } from "../stores/session";
import { useTurnActive } from "./turn-activity";

export type SessionStatus = "idle" | "running" | "waiting" | "done";

export interface SessionStatusInput {
  /** 会话是否已有消息（没有 = 还没开跑）。 */
  hasMessages: boolean;
  /** 该会话有在途回合。 */
  running: boolean;
  /** 该会话卡在等用户（计划门 / 提问 / 权限确认 / 队列）。 */
  waiting: boolean;
}

/** 纯派生：等待中 > 运行 > 结束 > 未开始。 */
export function sessionStatus(input: SessionStatusInput): SessionStatus {
  if (input.waiting) return "waiting";
  if (input.running) return "running";
  return input.hasMessages ? "done" : "idle";
}

/**
 * 按会话 id 取状态的组合式。返回的是函数而非 computed：侧栏一次要算几十行，
 * 每行各自 computed 会多出大量无谓的依赖追踪，直接调用更省。
 */
export function useSessionStatus(): (id: string) => SessionStatus {
  const chat = useChatStore();
  const agent = useAgentStore();
  const session = useSessionStore();

  /** 回合活跃：本地 LLM 流 / ACP 回合 / ACP 建会话（判定收在 lib/turn-activity）。 */
  const turnActive = useTurnActive();

  return function statusOf(id: string): SessionStatus {
    const messages = session.getSession(id)?.messages ?? [];
    // busy / acpBusy 是全局锁，必须同时命中 runningSessionId 才能把「运行」钉到具体会话。
    const running = chat.runningSessionId === id && turnActive.value;
    const waiting =
      messages.some((message) => message.planPending || (message.ask && !message.ask.answeredAt)) ||
      (Boolean(agent.pendingPermission) && chat.runningSessionId === id) ||
      (chat.commandQueue.length > 0 && chat.runningSessionId === id);
    return sessionStatus({ hasMessages: messages.length > 0, running, waiting });
  };
}
