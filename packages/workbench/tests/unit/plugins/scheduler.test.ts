import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CapabilityGrantSpec } from "@/plugins/capabilities";
import {
  attachScheduledClock,
  declaredScheduleOf,
  detachScheduledClock,
  effectiveRegionSchedule,
  nextDueFor,
  resetSchedulerForTest,
  runScheduledChecks,
  scheduledClockCount,
  type ScheduledClock,
} from "@/plugins/scheduler";
import type { DeclarativeValue } from "@/plugins/market-types";

/**
 * schedule 宿主持调度器引擎单测（node 环境）：
 *  - 声明解析（declaredScheduleOf）：形态校验 + 边界
 *  - 授权门禁（effectiveRegionSchedule）：声明 + 已授权才挂钟
 *  - 挂钟：首挂排期、离线补结算、到点触发一次 + 推进 nextDue
 *  - 不重入（正在运行跳帧）、唤醒失败仍推进、detach 后不再触发
 *  - nextDue 持久化断言
 */

const storageHolder = globalThis as { localStorage?: Storage };

function injectStorage(): void {
  const backing: Record<string, string> = {};
  storageHolder.localStorage = {
    getItem: (key: string) => backing[key] ?? null,
    setItem: (key: string, value: string) => {
      backing[key] = value;
    },
    removeItem: (key: string) => {
      delete backing[key];
    },
    clear: () => {
      for (const key of Object.keys(backing)) delete backing[key];
    },
    key: (index: number) => Object.keys(backing)[index] ?? null,
    get length() {
      return Object.keys(backing).length;
    },
  } as Storage;
}

interface Fixture {
  state: Record<string, DeclarativeValue>;
  invokes: Array<{ handler: string; state: Record<string, DeclarativeValue> }>;
  invoke: ScheduledClock["invoke"];
  makeClock: (everyMin?: number) => ScheduledClock;
}

function fixture(): Fixture {
  const state: Record<string, DeclarativeValue> = { count: 0 };
  const invokes: Array<{ handler: string; state: Record<string, DeclarativeValue> }> = [];
  const invoke: ScheduledClock["invoke"] = async (_handler, passed) => {
    invokes.push({ handler: _handler, state: { ...passed } });
    return { count: (typeof state.count === "number" ? state.count : 0) + 1 };
  };
  const makeClock = (everyMin = 60): ScheduledClock => ({
    pluginId: "demo.schedule",
    regionId: "main",
    everyMin,
    state: () => ({ ...state }),
    applyPatch: (patch) => {
      for (const [patchKey, patchValue] of Object.entries(patch)) state[patchKey] = patchValue;
    },
    invoke,
  });
  return { state, invokes, invoke, makeClock };
}

beforeEach(() => {
  injectStorage();
  resetSchedulerForTest();
});

afterEach(() => {
  resetSchedulerForTest();
  delete storageHolder.localStorage;
});

describe("declaredScheduleOf 声明解析", () => {
  it("无声明 / 空声明 → null", () => {
    expect(declaredScheduleOf(undefined)).toBeNull();
    expect(declaredScheduleOf([])).toBeNull();
    expect(declaredScheduleOf(["storage.kv"])).toBeNull();
  });

  it("参数化 schedule 声明 → { everyMin }", () => {
    const spec: CapabilityGrantSpec[] = [{ capability: "schedule", schedule: { kind: "interval", min: 60 } }];
    expect(declaredScheduleOf(spec)).toEqual({ everyMin: 60 });
  });

  it("kind 非 interval / min 越界 / 非整数 → null", () => {
    expect(declaredScheduleOf([{ capability: "schedule", schedule: { kind: "interval", min: 4 } }])).toBeNull();
    expect(declaredScheduleOf([{ capability: "schedule", schedule: { kind: "interval", min: 1441 } }])).toBeNull();
    expect(declaredScheduleOf([{ capability: "schedule", schedule: { kind: "interval", min: 1.5 } }])).toBeNull();
    // 形态不符（Rust 安装期已拦，前端只管得住）：直接强转成坏输入。
    expect(
      declaredScheduleOf([{ capability: "schedule", schedule: { kind: "cron", min: 60 } } as unknown as CapabilityGrantSpec]),
    ).toBeNull();
    expect(declaredScheduleOf([{ capability: "schedule", hosts: ["x"] } as CapabilityGrantSpec])).toBeNull();
  });
});

describe("effectiveRegionSchedule 授权门禁", () => {
  const manifest: { requires: CapabilityGrantSpec[] } = {
    requires: [{ capability: "schedule", schedule: { kind: "interval", min: 30 } }],
  };

  it("已授权 → 返回声明；未授权 → null（宿主不挂钟）", () => {
    expect(effectiveRegionSchedule(manifest, () => true)).toEqual({ everyMin: 30 });
    expect(effectiveRegionSchedule(manifest, () => false)).toBeNull();
  });

  it("未声明 → null，即便授权", () => {
    expect(effectiveRegionSchedule({ requires: ["storage.kv"] }, () => true)).toBeNull();
  });
});

describe("挂钟生命周期", () => {
  it("首挂：排定首轮到期，未到期不触发", async () => {
    const f = fixture();
    const clock = f.makeClock(60);
    await attachScheduledClock(clock, 1_000_000);
    expect(scheduledClockCount()).toBe(1);
    expect(f.invokes).toHaveLength(0);
    expect(nextDueFor("demo.schedule", "main")).toBe(1_000_000 + 60 * 60_000);

    await runScheduledChecks(1_000_000 + 59 * 60_000);
    expect(f.invokes).toHaveLength(0);

    await runScheduledChecks(1_000_000 + 60 * 60_000);
    expect(f.invokes).toHaveLength(1);
    expect(f.state.count).toBe(1);
    expect(nextDueFor("demo.schedule", "main")).toBe(1_000_000 + 120 * 60_000);
  });

  it("离线补结算：挂载时已过期 → 立即补触发一次并重置", async () => {
    const f = fixture();
    // 模拟：上次运行排期在很久以前（离线期间错过了）。
    const dueMap = { [`demo.schedule/region/main`]: 500_000 };
    storageHolder.localStorage!.setItem("greywork.plugins.schedule.due", JSON.stringify(dueMap));

    await attachScheduledClock(f.makeClock(60), 1_000_000);
    expect(f.invokes).toHaveLength(1);
    expect(f.state.count).toBe(1);
    expect(nextDueFor("demo.schedule", "main")).toBe(1_000_000 + 60 * 60_000);
  });

  it("到点后不重入：invoke 未返回时不重复触发，且 nextDue 顺延", async () => {
    const f = fixture();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let called = 0;
    const slowClock: ScheduledClock = {
      ...f.makeClock(60),
      invoke: async () => {
        called++;
        await gate;
        return { count: 99 };
      },
    };
    await attachScheduledClock(slowClock, 1_000_000);
    // 首挂排期到 2000_000；把排期拨到过去再跑两轮。
    storageHolder.localStorage!.setItem("greywork.plugins.schedule.due", JSON.stringify({ "demo.schedule/region/main": 1_000_000 }));
    const first = runScheduledChecks(1_000_000);
    await runScheduledChecks(1_000_000);
    release();
    await first;
    expect(called).toBe(1);
    expect(f.state.count).toBe(99);
  });

  it("唤醒失败（worker 崩溃/超时）也推进 nextDue，不抛给调用方", async () => {
    const f = fixture();
    const brokenClock: ScheduledClock = {
      ...f.makeClock(60),
      invoke: async () => {
        throw new Error("worker crashed");
      },
    };
    await attachScheduledClock(brokenClock, 1_000_000);
    storageHolder.localStorage!.setItem("greywork.plugins.schedule.due", JSON.stringify({ "demo.schedule/region/main": 1_000_000 }));
    await expect(runScheduledChecks(1_000_000)).resolves.toBeUndefined();
    expect(nextDueFor("demo.schedule", "main")).toBe(1_000_000 + 60 * 60_000);
  });

  it("detach 后不再触发；再次 attach（未过期）不补触发", async () => {
    const f = fixture();
    const clock = f.makeClock(60);
    await attachScheduledClock(clock, 1_000_000);
    expect(scheduledClockCount()).toBe(1);
    detachScheduledClock("demo.schedule", "main");
    expect(scheduledClockCount()).toBe(0);

    storageHolder.localStorage!.setItem("greywork.plugins.schedule.due", JSON.stringify({ "demo.schedule/region/main": 1_000_000 }));
    await runScheduledChecks(2_000_000);
    expect(f.invokes).toHaveLength(0);
  });
});
