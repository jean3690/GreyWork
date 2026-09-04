import type { BudgetBreach, CoworkBudget, CoworkSpend, CoworkUsage } from "./types";

export interface LedgerDeps {
  budget: CoworkBudget;
  spend: CoworkSpend;
  now(): number;
}

export interface Ledger {
  /** 记一个回合：派发前记账，于是第 N+1 个回合会被 {@link Ledger.breach} 拦住。 */
  chargeTurn(slotId: string): void;
  /** ACP 的 usage 是本会话累计快照，按成员位覆盖存最新值。 */
  recordUsage(slotId: string, usage: Partial<CoworkUsage>): void;
  /** 各成员位快照求和后的总量。 */
  totals(): CoworkUsage;
  /** 首个触顶项；null 表示仍在预算内。检查顺序固定，便于测试与报错定位。 */
  breach(): BudgetBreach | null;
}

export function createLedger(deps: LedgerDeps): Ledger {
  const { budget, spend, now } = deps;

  const totals = (): CoworkUsage => {
    let tokens = 0;
    let cost = 0;
    for (const usage of Object.values(spend.usageBySlot)) {
      tokens += usage.tokens;
      cost += usage.cost;
    }
    return { tokens, cost };
  };

  return {
    chargeTurn(slotId) {
      spend.turns += 1;
      spend.turnsBySlot[slotId] = (spend.turnsBySlot[slotId] ?? 0) + 1;
    },

    recordUsage(slotId, usage) {
      const current = spend.usageBySlot[slotId] ?? { tokens: 0, cost: 0 };
      spend.usageBySlot[slotId] = {
        tokens: usage.tokens ?? current.tokens,
        cost: usage.cost ?? current.cost,
      };
    },

    totals,

    breach() {
      if (spend.turns >= budget.maxTurns) return "run_turns";
      for (const turns of Object.values(spend.turnsBySlot)) {
        if (turns >= budget.maxTurnsPerSlot) return "slot_turns";
      }
      if (now() - spend.startedAt >= budget.maxWallClockMs) return "wall_clock";
      const used = totals();
      if (budget.maxTokens !== undefined && used.tokens >= budget.maxTokens) return "tokens";
      if (budget.maxCost !== undefined && used.cost >= budget.maxCost) return "cost";
      return null;
    },
  };
}
