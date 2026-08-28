/**
 * 类型安全的发布-订阅（Pub-Sub）事件总线。
 *
 * 用于异步任务完成通知与跨模块解耦通信：生产者 `emit`，消费者 `on`/`once`。
 * - 事件名与载荷在 `E extends Record<string, unknown>` 中静态声明，编译期校验；
 * - handler 错误隔离：单个订阅者抛错不影响其余订阅者（错误经 console.error 上报，不吞没）；
 * - `on` 返回取消订阅函数，适配组件/effect 清理。
 */

export interface PubSub<E extends object> {
  /** 订阅事件；返回取消订阅函数。 */
  on<K extends keyof E>(event: K, handler: (payload: E[K]) => void): () => void;
  /** 订阅一次性事件：触发一次后自动移除。 */
  once<K extends keyof E>(event: K, handler: (payload: E[K]) => void): () => void;
  /** 移除精确匹配的订阅。 */
  off<K extends keyof E>(event: K, handler: (payload: E[K]) => void): void;
  /** 同步派发事件：按订阅顺序依次调用；单个 handler 抛错被隔离。 */
  emit<K extends keyof E>(event: K, payload: E[K]): void;
  /** 清空指定事件（缺省清空全部）的订阅。 */
  clear(event?: keyof E): void;
  /** 指定事件的订阅者数量（诊断用）。 */
  listenerCount<K extends keyof E>(event: K): number;
}

export function createEventBus<E extends object>(): PubSub<E> {
  const listeners = new Map<keyof E, Set<(payload: unknown) => void>>();

  function handlersOf<K extends keyof E>(event: K): Set<(payload: unknown) => void> {
    let handlers = listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      listeners.set(event, handlers);
    }
    return handlers;
  }

  function on<K extends keyof E>(event: K, handler: (payload: E[K]) => void): () => void {
    handlersOf(event).add(handler as (payload: unknown) => void);
    return () => off(event, handler);
  }

  function once<K extends keyof E>(event: K, handler: (payload: E[K]) => void): () => void {
    const wrapper = (payload: unknown) => {
      handlersOf(event).delete(wrapper);
      handler(payload as E[K]);
    };
    handlersOf(event).add(wrapper);
    return () => {
      handlersOf(event).delete(wrapper);
    };
  }

  function off<K extends keyof E>(event: K, handler: (payload: E[K]) => void): void {
    handlersOf(event).delete(handler as (payload: unknown) => void);
  }

  function emit<K extends keyof E>(event: K, payload: E[K]): void {
    const handlers = listeners.get(event);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[pubsub] handler for "${String(event)}" threw`, error);
      }
    }
  }

  function clear(event?: keyof E): void {
    if (event === undefined) {
      listeners.clear();
      return;
    }
    listeners.delete(event);
  }

  function listenerCount<K extends keyof E>(event: K): number {
    return listeners.get(event)?.size ?? 0;
  }

  return { on, once, off, emit, clear, listenerCount };
}
