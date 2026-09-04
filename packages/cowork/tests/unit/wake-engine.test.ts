import { describe, expect, it } from "vitest";
import { createWakeEngine } from "../../src/wake-engine";

/** 造一个可控的唤醒引擎：work 集合决定谁有活干，dispatched 记录派发顺序。 */
function harness(maxParallel = 1) {
  const work = new Set<string>();
  const dispatched: string[] = [];
  const engine = createWakeEngine({
    maxParallel,
    hasWork: (slotId) => work.has(slotId),
    dispatch: (slotId) => {
      dispatched.push(slotId);
      // 派发即消费掉这一批活；再有新活由调用方重新 add。
      work.delete(slotId);
    },
  });
  return { work, dispatched, engine };
}

describe("createWakeEngine", () => {
  it("无活可干时不派发，状态保持 idle", () => {
    const { engine, dispatched } = harness();
    engine.wake("a");
    expect(dispatched).toEqual([]);
    expect(engine.stateOf("a")).toBe("idle");
    expect(engine.inflight()).toBe(0);
  });

  it("回合进行中到达的唤醒置 dirty，收尾后立刻补派一次", () => {
    const { engine, dispatched, work } = harness();
    work.add("a");
    engine.wake("a");
    expect(dispatched).toEqual(["a"]);
    expect(engine.stateOf("a")).toBe("running");

    work.add("a"); // 回合中又来了新信
    engine.wake("a");
    expect(engine.stateOf("a")).toBe("dirty");
    expect(dispatched).toEqual(["a"]); // 不并发派发同一成员位

    engine.turnEnded("a");
    expect(dispatched).toEqual(["a", "a"]);
    expect(engine.stateOf("a")).toBe("running");
  });

  it("回合中的多次唤醒合并为一次补派", () => {
    const { engine, dispatched, work } = harness();
    work.add("a");
    engine.wake("a");
    work.add("a");
    engine.wake("a");
    engine.wake("a");
    engine.wake("a");
    engine.turnEnded("a");
    expect(dispatched).toEqual(["a", "a"]);
  });

  it("dirty 收尾时若活已被别处消费，则不空派", () => {
    const { engine, dispatched, work } = harness();
    work.add("a");
    engine.wake("a");
    work.add("a");
    engine.wake("a");
    work.delete("a"); // 活被消费
    engine.turnEnded("a");
    expect(dispatched).toEqual(["a"]);
    expect(engine.stateOf("a")).toBe("idle");
    expect(engine.inflight()).toBe(0);
  });

  it("超出并发上限的唤醒入队而非丢弃，先来先服务", () => {
    const { engine, dispatched, work } = harness(2);
    work.add("a");
    work.add("b");
    work.add("c");
    engine.wake("a");
    engine.wake("b");
    engine.wake("c");
    expect(dispatched).toEqual(["a", "b"]);
    expect(engine.queued()).toEqual(["c"]);

    engine.turnEnded("a");
    expect(dispatched).toEqual(["a", "b", "c"]);
    expect(engine.queued()).toEqual([]);
  });

  it("排队期间重复唤醒不会重复入队", () => {
    const { engine, work } = harness(1);
    work.add("a");
    work.add("b");
    engine.wake("a");
    engine.wake("b");
    engine.wake("b");
    engine.wake("b");
    expect(engine.queued()).toEqual(["b"]);
  });

  it("非运行态收到回合结束是噪声，不凭空派发也不把计数弄负", () => {
    const { engine, dispatched, work } = harness();
    engine.turnEnded("a");
    expect(dispatched).toEqual([]);
    expect(engine.inflight()).toBe(0);

    work.add("a");
    engine.wake("a");
    engine.turnEnded("a");
    engine.turnEnded("a"); // 重复的收尾事件
    expect(dispatched).toEqual(["a"]);
    expect(engine.inflight()).toBe(0);
  });

  it("block 期间不启动新回合，unblock 后补齐", () => {
    const { engine, dispatched, work } = harness(2);
    engine.block();
    work.add("a");
    engine.wake("a");
    expect(dispatched).toEqual([]);
    expect(engine.queued()).toEqual(["a"]);
    expect(engine.blocked()).toBe(true);

    engine.unblock();
    expect(dispatched).toEqual(["a"]);
    expect(engine.blocked()).toBe(false);
  });

  it("clear 清空锁与队列", () => {
    const { engine, work } = harness(1);
    work.add("a");
    work.add("b");
    engine.wake("a");
    engine.wake("b");
    engine.clear();
    expect(engine.inflight()).toBe(0);
    expect(engine.queued()).toEqual([]);
    expect(engine.stateOf("a")).toBe("idle");
  });
});
