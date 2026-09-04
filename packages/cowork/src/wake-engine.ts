import type { WakeState } from "./types";

export interface WakeEngineDeps {
  /** 同时在跑的回合上限；传函数以支持运行期调整。 */
  maxParallel: number | (() => number);
  /** 该成员位是否有活可干（通常等价于「收件箱有未读」）。 */
  hasWork(slotId: string): boolean;
  /** 发起一个回合。同步调用，实际的异步执行由上层负责。 */
  dispatch(slotId: string): void;
  onState?(slotId: string, state: WakeState): void;
}

export interface WakeEngine {
  /**
   * 边触发唤醒。running 期间到达则置 dirty（多次唤醒合并为一次补派），
   * 超出并发上限则入队——任何情况下都不丢弃唤醒。
   */
  wake(slotId: string): void;
  /** 回合结束。dirty 则立刻补派该成员位，否则从队列里补位。 */
  turnEnded(slotId: string): void;
  stateOf(slotId: string): WakeState;
  /** 正在跑的回合数（引用计数式静止判定的另一半输入）。 */
  inflight(): number;
  /** 排队等并发位的成员位，先来先服务。 */
  queued(): readonly string[];
  /** 暂停派发（预算触顶）：已排队的唤醒保留，不再启动新回合。 */
  block(): void;
  unblock(): void;
  blocked(): boolean;
  /** 清空全部锁与队列（取消运行时用）。 */
  clear(): void;
}

export function createWakeEngine(deps: WakeEngineDeps): WakeEngine {
  const states = new Map<string, WakeState>();
  const queue: string[] = [];
  let running = 0;
  let blocked = false;

  const limit = (): number => (typeof deps.maxParallel === "function" ? deps.maxParallel() : deps.maxParallel);

  const setState = (slotId: string, state: WakeState): void => {
    states.set(slotId, state);
    deps.onState?.(slotId, state);
  };

  const start = (slotId: string): void => {
    running += 1;
    setState(slotId, "running");
    deps.dispatch(slotId);
  };

  const pump = (): void => {
    while (!blocked && running < limit() && queue.length > 0) {
      const slotId = queue.shift() as string;
      if (!deps.hasWork(slotId)) {
        setState(slotId, "idle");
        continue;
      }
      start(slotId);
    }
  };

  const enqueue = (slotId: string): void => {
    if (!queue.includes(slotId)) queue.push(slotId);
  };

  return {
    wake(slotId) {
      const state = states.get(slotId) ?? "idle";
      if (state === "running") {
        setState(slotId, "dirty");
        return;
      }
      // dirty 已经记账，重复唤醒无需再记；排队中的同样已在册。
      if (state === "dirty" || queue.includes(slotId)) return;
      if (!deps.hasWork(slotId)) return;
      if (blocked || running >= limit()) {
        enqueue(slotId);
        return;
      }
      start(slotId);
    },

    turnEnded(slotId) {
      const state = states.get(slotId) ?? "idle";
      // 未在跑的成员位收到回合结束是噪声（重复的 prompt-done、看门狗与
      // 正常收尾撞车），忽略，否则会凭空多派一个回合。
      if (state !== "running" && state !== "dirty") return;
      running -= 1;
      setState(slotId, "idle");
      if (state === "dirty" && deps.hasWork(slotId)) {
        if (blocked || running >= limit()) enqueue(slotId);
        else start(slotId);
      }
      pump();
    },

    stateOf(slotId) {
      return states.get(slotId) ?? "idle";
    },

    inflight() {
      return running;
    },

    queued() {
      return queue;
    },

    block() {
      blocked = true;
    },

    unblock() {
      blocked = false;
      pump();
    },

    blocked() {
      return blocked;
    },

    clear() {
      states.clear();
      queue.length = 0;
      running = 0;
      blocked = false;
    },
  };
}
