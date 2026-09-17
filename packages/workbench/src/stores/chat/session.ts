/**
 * 会话派生切片：当前会话 id / 线程消息映射 / 消息读写桥。
 *
 * 与 state 的 store 实例不同，这里产出的是**派生**：activeThreadId 与 threads
 * 都实时读 sessionStore；ensure / push 是薄封装。因为 busy / speedBoost 等
 * 锁在 state，所有要读写消息的切片（stream / demo / submit）都经 getSession()
 * 拿到这份 api，避免各自重复实现「取当前线程 / 落消息」。
 */
import { computed, type ComputedRef, type WritableComputedRef } from "vue";
import type { ThreadMessage } from "../../types";
import type { ChatStoreState } from "./state";

export interface SessionApi {
  /** 当前会话 id：由持久化会话存储托管（computed+setter 保持原赋值语义）。 */
  activeThreadId: WritableComputedRef<string>;
  /** 线程 id → 消息列表（派生自会话存储；消息对象响应式共享）。 */
  threads: ComputedRef<Record<string, ThreadMessage[]>>;
  ensure(threadId: string): ThreadMessage[];
  push(threadId: string, message: ThreadMessage): void;
}

export function createSessionSlice({ state }: { state: ChatStoreState }): SessionApi {
  const activeThreadId = computed<string>({
    get: () => state.sessionStore.activeSessionId ?? "",
    set: (value) => state.sessionStore.setActive(value || null),
  });
  const threads = computed<Record<string, ThreadMessage[]>>(() => {
    const map: Record<string, ThreadMessage[]> = {};
    for (const session of state.sessionStore.sessions) map[session.id] = session.messages;
    return map;
  });

  function ensure(threadId: string): ThreadMessage[] {
    return state.sessionStore.ensure(threadId);
  }
  function push(threadId: string, message: ThreadMessage): void {
    state.sessionStore.appendMessage(threadId, message);
  }

  return { activeThreadId, threads, ensure, push };
}
