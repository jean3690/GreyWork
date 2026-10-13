import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import WorkspaceOverlayRegions from "@/features/shell/WorkspaceOverlayRegions.vue";
import PluginRegionHost from "@/features/plugins/PluginRegionHost.vue";
import { createCapabilityLoader } from "@/plugins/loader";
import { setCapabilityLoaderForTest } from "@/plugins/current";
import { resetPluginRuntime } from "@/plugins/runtime";
import { adaptInstalledPlugin } from "@/plugins/declarative";
import { resetSchedulerForTest } from "@/plugins/scheduler";
import type { DeclarativeValue, InstalledPluginPackage } from "@/plugins/market-types";

/**
 * schedule 区域接线的真·Vue 集成测试（补 scheduler.test.ts 覆盖不到的宿主接线缝隙）：
 *
 *   adapter（declarative.ts）：effectiveRegionSchedule(manifest, granted) → PluginRegionHost.schedule
 *     → PluginRegionHost.onMounted：attachScheduledClock
 *     → 挂载时过期（离线补结算）→ invoke("schedule", state)
 *     → applyPatch 合并进区域 reactive 状态 → 渲染循环下一拍把新状态喂给 draw
 *
 * 引擎逻辑/授权门禁分别在 scheduler.test.ts / capabilities.schedule.test.ts 覆盖；这里只钉住
 * 「组件把钟挂对、补丁合进渲染状态」这段此前没有测试的胶水。
 */

const plan = { kind: "interval" as const, min: 60 };

const pluginPackage: InstalledPluginPackage = {
  schemaVersion: 1,
  // worker 代码：render 处理器（draw）+ 后台定时处理器（registerSchedule）。
  code: `
    greywork.registerAction("draw", (state) => [{ kind: "circle", cx: 30, cy: 30, r: state.count ? 20 : 12, fill: "#7bd88f" }]);
    greywork.registerSchedule(async (state) => ({ count: (typeof state.count === "number" ? state.count : 0) + 1, lastKind: "后台" }));
  `,
  manifest: {
    id: "demo.sched",
    name: "定时巡检",
    version: "1.0.0",
    kind: "worker",
    runtime: {
      type: "worker",
      entry: "https://raw.githubusercontent.com/acme/demo/main/demo.js",
      sha256: "a".repeat(64),
      render: { handler: "draw", fps: 12, width: 160, height: 150 },
    },
    requires: [{ capability: "schedule", schedule: plan }],
    contributes: {
      modes: [
        {
          id: "demo-sched",
          title: "定时巡检",
          page: { heading: "h", body: "b", fields: [], outputs: [], actions: [] },
        },
      ],
      uiRegions: [
        {
          region: "workspaceOverlay",
          id: "tick.overlay",
          title: "巡检",
          order: 5,
          width: 160,
          height: 150,
          actions: [],
        },
      ],
    },
  },
};

const REGION_KEY = "demo.sched/region/tick.overlay";

/** 假 worker runtime：schedule handler 返回补丁，draw 返回画布指令。 */
function createFakeRuntime() {
  const handlers = new Map<string, (state: Record<string, unknown>) => unknown>();
  return {
    runtime: {
      invoke: vi.fn(async (handler: string, state: Record<string, unknown>): Promise<Record<string, DeclarativeValue> | void> => {
        const fn = handlers.get(handler);
        if (!fn) throw new Error(`no handler ${handler}`);
        return fn(state) as Record<string, DeclarativeValue> | void;
      }),
      invokeRaw: vi.fn(async (handler: string, state: Record<string, unknown>): Promise<unknown> => {
        const fn = handlers.get(handler);
        if (!fn) throw new Error(`no handler ${handler}`);
        return fn(state);
      }),
      dispatchPointer: vi.fn(async (): Promise<Record<string, DeclarativeValue> | void> => undefined),
      dispose: vi.fn(),
    },
    on(handler: string, fn: (state: Record<string, unknown>) => unknown) {
      handlers.set(handler, fn);
    },
  };
}

let mounted: VueWrapper | undefined;

beforeEach(async () => {
  window.localStorage.clear();
  resetSchedulerForTest();
  setCapabilityLoaderForTest(createCapabilityLoader());
  resetPluginRuntime();
  const { bootPlugins } = await import("@/plugins/runtime");
  await bootPlugins();
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  resetSchedulerForTest();
  setCapabilityLoaderForTest(null);
  resetPluginRuntime();
  window.localStorage.clear();
});

describe("schedule 区域接线（真·Vue）", () => {
  it("已授权：区域挂载即补结算一次——worker 的 registerSchedule 被唤醒，补丁合进渲染状态", async () => {
    const fake = createFakeRuntime();
    fake.on("draw", (state) => [{ kind: "circle", cx: 30, cy: 30, r: state.count ? 20 : 12 }]);
    fake.on("schedule", (state) => ({ count: (typeof state.count === "number" ? state.count : 0) + 1 }));

    const { registerPlugin, setPluginEnabled, grantPluginCapability } = await import("@/plugins/runtime");
    registerPlugin(adaptInstalledPlugin(pluginPackage, fake.runtime));
    grantPluginCapability("demo.sched", "schedule");
    await setPluginEnabled("demo.sched", true);

    // 模拟离线错过：挂载前把上一轮排期拨到过去 → onMounted 的 attach 走「离线补结算」立即唤醒。
    window.localStorage.setItem("greywork.plugins.schedule.due", JSON.stringify({ [REGION_KEY]: Date.now() - 1 }));

    const wrapper = mount(WorkspaceOverlayRegions);
    mounted = wrapper;
    expect(wrapper.findComponent(PluginRegionHost).exists()).toBe(true);

    await flushPromises();
    // 组件挂钟 → 唤醒 schedule handler（授权后宿主才执行定时）。
    expect(fake.runtime.invoke).toHaveBeenCalledWith("schedule", expect.any(Object));

    // 补丁合并进区域状态：再补一轮，该轮 clock.state() 读到上一轮写的 count=1，
    // 证明 applyPatch 全量合并到了组件的 reactive 状态。
    window.localStorage.setItem("greywork.plugins.schedule.due", JSON.stringify({ [REGION_KEY]: Date.now() - 1 }));
    const { runScheduledChecks } = await import("@/plugins/scheduler");
    await runScheduledChecks(Date.now());
    const scheduleStates = fake.runtime.invoke.mock.calls
      .filter((call) => call[0] === "schedule")
      .map((call) => call[1] as Record<string, unknown>);
    expect(scheduleStates.at(-1)?.count).toBe(1);
  });

  it("卸载即摘钟：区域从壳上消失后，下一次到点不再唤醒", async () => {
    const fake = createFakeRuntime();
    fake.on("draw", () => []);
    fake.on("schedule", () => ({ count: 1 }));

    const { registerPlugin, setPluginEnabled, grantPluginCapability } = await import("@/plugins/runtime");
    registerPlugin(adaptInstalledPlugin(pluginPackage, fake.runtime));
    grantPluginCapability("demo.sched", "schedule");
    await setPluginEnabled("demo.sched", true);

    window.localStorage.setItem("greywork.plugins.schedule.due", JSON.stringify({ [REGION_KEY]: Date.now() - 1 }));
    const wrapper = mount(WorkspaceOverlayRegions);
    mounted = wrapper;
    await flushPromises();
    const callsWhileMounted = fake.runtime.invoke.mock.calls.length;
    expect(callsWhileMounted).toBeGreaterThanOrEqual(1);

    wrapper.unmount();
    mounted = undefined;

    // 卸载后再把排期拨到过去并跑一轮：钟已摘，不应再唤醒。
    window.localStorage.setItem("greywork.plugins.schedule.due", JSON.stringify({ [REGION_KEY]: Date.now() - 1 }));
    const { runScheduledChecks } = await import("@/plugins/scheduler");
    await runScheduledChecks(Date.now());
    expect(fake.runtime.invoke.mock.calls.length).toBe(callsWhileMounted);
  });
});
