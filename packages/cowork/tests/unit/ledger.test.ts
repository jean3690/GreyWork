import { describe, expect, it } from "vitest";
import { createLedger } from "../../src/ledger";
import { DEFAULT_COWORK_BUDGET, type CoworkBudget, type CoworkSpend } from "../../src/types";

function harness(budget?: Partial<CoworkBudget>) {
  let clock = 0;
  const spend: CoworkSpend = { turns: 0, turnsBySlot: {}, usageBySlot: {}, startedAt: 0 };
  const ledger = createLedger({
    budget: { ...DEFAULT_COWORK_BUDGET, ...budget },
    spend,
    now: () => clock,
  });
  return {
    ledger,
    spend,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createLedger", () => {
  it("回合记账落到 run 与成员位两级", () => {
    const { ledger, spend } = harness();
    ledger.chargeTurn("slot-a");
    ledger.chargeTurn("slot-a");
    ledger.chargeTurn("slot-b");
    expect(spend.turns).toBe(3);
    expect(spend.turnsBySlot).toEqual({ "slot-a": 2, "slot-b": 1 });
  });

  it("预算内返回 null，run 回合触顶优先于成员位回合", () => {
    const { ledger } = harness({ maxTurns: 2, maxTurnsPerSlot: 1 });
    expect(ledger.breach()).toBeNull();
    ledger.chargeTurn("slot-a");
    // 成员位已满 1 回合：先报 run 级上限吗？run 还差一个，所以此处应报 slot_turns
    expect(ledger.breach()).toBe("slot_turns");
    ledger.chargeTurn("slot-b");
    expect(ledger.breach()).toBe("run_turns");
  });

  it("墙钟按注入时钟判定", () => {
    const { ledger, tick } = harness({ maxWallClockMs: 1000 });
    expect(ledger.breach()).toBeNull();
    tick(999);
    expect(ledger.breach()).toBeNull();
    tick(1);
    expect(ledger.breach()).toBe("wall_clock");
  });

  it("usage 是覆盖式快照而非累加，总量跨成员位求和", () => {
    const { ledger } = harness({ maxTokens: 300 });
    ledger.recordUsage("slot-a", { tokens: 100 });
    ledger.recordUsage("slot-a", { tokens: 120 });
    expect(ledger.totals().tokens).toBe(120);

    ledger.recordUsage("slot-b", { tokens: 100 });
    expect(ledger.totals().tokens).toBe(220);
    expect(ledger.breach()).toBeNull();

    ledger.recordUsage("slot-b", { tokens: 200 });
    expect(ledger.breach()).toBe("tokens");
  });

  it("只更新 cost 时不清掉已记录的 tokens", () => {
    const { ledger } = harness({ maxCost: 1 });
    ledger.recordUsage("slot-a", { tokens: 50, cost: 0.4 });
    ledger.recordUsage("slot-a", { cost: 0.9 });
    expect(ledger.totals()).toEqual({ tokens: 50, cost: 0.9 });
    expect(ledger.breach()).toBeNull();

    ledger.recordUsage("slot-b", { cost: 0.2 });
    expect(ledger.breach()).toBe("cost");
  });
});
