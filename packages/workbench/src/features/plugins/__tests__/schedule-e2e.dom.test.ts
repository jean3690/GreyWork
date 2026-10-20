import { describe, expect, it } from "vitest";
import { workerPrelude } from "@/plugins/code-runtime";
import { createCapabilityLoader, type CapabilityLoader } from "@/plugins/loader";
import {
  attachScheduledClock,
  detachScheduledClock,
  nextDueFor,
  resetSchedulerForTest,
  runScheduledChecks,
  type ScheduledClock,
} from "@/plugins/scheduler";
import type { DeclarativeValue } from "@/plugins/market-types";

/**
 * schedule 能力调用全链路集成测试（与 fs-scoped-e2e / notify-e2e 同构）：
 *
 *   宿主调度器（scheduler.ts 引擎）
 *     → ScheduledClock.invoke("schedule", state)        ← PluginRegionHost 挂钟时绑定的
 *     → worker "invoke" 消息 → prelude 里 registerSchedule 注册的处理器
 *     → handler 返回状态补丁
 *     → clock.applyPatch 合并进区域状态 → nextDue 推进并持久化
 *
 * 链路上每一环都是真实代码（除 worker 运输层用模拟作用域代替）。授权门禁
 * （effectiveRegionSchedule：声明 + 已授权）在 scheduler.test.ts 里断言。
 */

/** 模拟 worker 作用域：prelude 把 greywork 挂在 scope（with 的全局语义）。 */
function createSimulatedWorker(pluginCode: string): {
  posted: unknown[];
  respond: (message: unknown) => void;
  invoke: (handler: string, state: Record<string, unknown>) => Promise<unknown>;
} {
  const posted: unknown[] = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const scope: Record<string, unknown> = {
    postMessage: (message: unknown) => {
      posted.push(message);
      const data = message as { type?: string };
      if (data?.type === "result") {
        for (const listener of [...listeners]) listener({ data: message });
      }
    },
    addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => listeners.push(listener),
  };
  const factory = new Function(
    "scope",
    `const factoryInner = (function () {
       return function (self, globalThis) {
         with (self) {
${workerPrelude}
${pluginCode}
         }
       };
     })();
     return factoryInner;`,
  );
  factory()(scope, scope);

  const respond = (message: unknown): void => {
    for (const listener of [...listeners]) listener({ data: message });
  };

  const invoke = (handler: string, state: Record<string, unknown>): Promise<unknown> => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const waitForResult = (event: { data: unknown }): void => {
      const data = event.data as { type?: string; requestId?: number; patch?: unknown; error?: unknown };
      if (data?.type === "result") {
        const index = listeners.indexOf(waitForResult);
        if (index >= 0) listeners.splice(index, 1);
        if (data.error !== undefined) reject(new Error(String(data.error)));
        else resolve(data.patch);
      }
    };
    listeners.push(waitForResult);
    for (const listener of [...listeners]) {
      if (listener !== waitForResult) listener({ data: { type: "invoke", requestId: -1, handler, state } });
    }
    return promise;
  };

  return { posted, respond, invoke };
}

/** 演示插件：后台巡检，每次 +1 并记录时间。 */
const schedulePluginCode = `
greywork.registerSchedule(async (state) => {
  const count = typeof state.count === "number" ? state.count + 1 : 1;
  // 定时处理器里可以照常调用宿主能力（这条链上无人调用）。
  return { count, lastKind: "后台", at: "2026-10-10T00:00:00.000Z" };
});
greywork.registerAction("settle", async (state) => ({
  count: (typeof state.count === "number" ? state.count : 0) + 1,
  lastKind: "手动",
}));
`;

const PLUGIN_ID = "demo.schedule";
const REGION_ID = "main";
const ATTACH_NOW = 1_000_000_000_000;
const EVERY_MIN = 60;

function registerAndActivate(loader: CapabilityLoader): void {
  loader.register({
    id: PLUGIN_ID,
    name: "定时演示",
    version: "1.0.0",
    requires: [{ capability: "schedule", schedule: { kind: "interval", min: EVERY_MIN } }],
  });
  loader.grantCapability(PLUGIN_ID, "schedule");
}

function makeClock(
  worker: { invoke: (handler: string, state: Record<string, unknown>) => Promise<unknown> },
  state: Record<string, DeclarativeValue>,
): ScheduledClock {
  return {
    pluginId: PLUGIN_ID,
    regionId: REGION_ID,
    everyMin: EVERY_MIN,
    state: () => ({ ...state }),
    applyPatch: (patch) => {
      for (const [patchKey, patchValue] of Object.entries(patch)) state[patchKey] = patchValue;
    },
    // worker 模拟通道返回 unknown；真实 runtime.invoke 已收窄为补丁/void。
    invoke: (handler, passed) => worker.invoke(handler, passed) as Promise<Record<string, DeclarativeValue> | void>,
  };
}

function dueKey(): string {
  return `${PLUGIN_ID}/region/${REGION_ID}`;
}

function setDue(ms: number): void {
  globalThis.localStorage.setItem("greywork.plugins.schedule.due", JSON.stringify({ [dueKey()]: ms }));
}

describe("schedule 能力调用全链路", () => {
  it("授权后：worker 的 registerSchedule 处理器被宿主按排期唤醒，补丁并回区域状态并持久化", async () => {
    resetSchedulerForTest();
    const loader = createCapabilityLoader();
    registerAndActivate(loader);
    await loader.activate(PLUGIN_ID);

    const worker = createSimulatedWorker(schedulePluginCode);
    const state: Record<string, DeclarativeValue> = { count: 0 };
    await attachScheduledClock(makeClock(worker, state), ATTACH_NOW);

    // 未到期：不触发。
    await runScheduledChecks(ATTACH_NOW + (EVERY_MIN - 1) * 60_000);
    expect(state.count).toBe(0);

    // 到点（把上级排期拨回过去模拟错过）：宿主唤醒 "schedule" 处理器一次。
    setDue(ATTACH_NOW);
    await runScheduledChecks(ATTACH_NOW);
    expect(state.count).toBe(1);
    expect(state.lastKind).toBe("后台");
    expect(nextDueFor(PLUGIN_ID, REGION_ID)).toBe(ATTACH_NOW + EVERY_MIN * 60_000);

    // 同一轮不再重复触发（nextDue 已前移）。
    await runScheduledChecks(ATTACH_NOW + EVERY_MIN * 60_000 - 1);
    expect(state.count).toBe(1);
    await runScheduledChecks(ATTACH_NOW + EVERY_MIN * 60_000);
    expect(state.count).toBe(2);

    detachScheduledClock(PLUGIN_ID, REGION_ID);
    resetSchedulerForTest();
  });

  it("离线补结算：挂载时已过期立即补触发一次并重置", async () => {
    resetSchedulerForTest();
    const loader = createCapabilityLoader();
    registerAndActivate(loader);
    await loader.activate(PLUGIN_ID);

    const worker = createSimulatedWorker(schedulePluginCode);
    const state: Record<string, DeclarativeValue> = { count: 0 };
    // 模拟离线错过：上一轮排期在很久以前，此刻挂载。
    setDue(ATTACH_NOW - 2 * EVERY_MIN * 60_000);

    await attachScheduledClock(makeClock(worker, state), ATTACH_NOW);
    expect(state.count).toBe(1);
    expect(state.lastKind).toBe("后台");
    expect(nextDueFor(PLUGIN_ID, REGION_ID)).toBe(ATTACH_NOW + EVERY_MIN * 60_000);

    detachScheduledClock(PLUGIN_ID, REGION_ID);
    resetSchedulerForTest();
  });

  it("registerAction 不能占用保留的 schedule 名", async () => {
    resetSchedulerForTest();
    expect(() =>
      createSimulatedWorker(`
        greywork.registerAction("schedule", async (state) => state);
      `),
    ).toThrow(/reserved for registerSchedule/);
    resetSchedulerForTest();
  });

  it("重复 registerSchedule 拒绝", async () => {
    resetSchedulerForTest();
    expect(() =>
      createSimulatedWorker(`
        greywork.registerSchedule(async (state) => state);
        greywork.registerSchedule(async (state) => state);
      `),
    ).toThrow(/already registered/);
    resetSchedulerForTest();
  });
});
