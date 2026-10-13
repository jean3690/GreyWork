import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityLoader, type CapabilityLoader } from "@/plugins/loader";
import { CAPABILITY_REGISTRY, normalizeGrantSpec, resetCapabilityAuditForTest } from "@/plugins/capabilities";
import type { PluginManifest } from "@/plugins/types";

/**
 * schedule 能力的注册表契约与门禁单测：
 *  - normalizeGrantSpec 归一出 schedule 定时参数
 *  - CAPABILITY_REGISTRY 含 schedule（插件中心展示来源）
 *  - 门禁：requires 声明 schedule → 未授权须补齐；grant 后可激活
 *  - worker 不应 call("schedule")：调用即抛 host-driven 错误（宿主驱动的能力）
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

function scheduleManifest(id = "demo.schedule"): PluginManifest {
  return {
    id,
    name: "定时插件",
    version: "1.0.0",
    requires: [{ capability: "schedule", schedule: { kind: "interval", min: 60 } }],
  };
}

let loader: CapabilityLoader;

beforeEach(() => {
  injectStorage();
  resetCapabilityAuditForTest();
  loader = createCapabilityLoader();
});

afterEach(() => {
  resetCapabilityAuditForTest();
  delete storageHolder.localStorage;
});

describe("schedule 声明归一化", () => {
  it("normalizeGrantSpec 保留定时参数", () => {
    expect(normalizeGrantSpec("schedule")).toEqual({ capability: "schedule" });
    expect(normalizeGrantSpec({ capability: "schedule", schedule: { kind: "interval", min: 60 } })).toEqual({
      capability: "schedule",
      schedule: { kind: "interval", min: 60 },
    });
    // 既有形态不受影响。
    expect(normalizeGrantSpec({ capability: "net.fetch", hosts: ["a.com"] })).toEqual({
      capability: "net.fetch",
      hosts: ["a.com"],
    });
  });
});

describe("CAPABILITY_REGISTRY 含 schedule", () => {
  it("注册表有 host-driven 的 schedule 条目（供插件中心展示与门禁）", async () => {
    const definition = CAPABILITY_REGISTRY["schedule"];
    expect(definition).toBeDefined();
    expect(definition.id).toBe("schedule");
    expect(definition.danger).toBe("low");
  });
});

describe("schedule 门禁与调用形态", () => {
  it("requires 声明 schedule → 未授权须补齐（activate 拒绝）；授权后可激活", async () => {
    loader.register(scheduleManifest());
    await expect(loader.activate("demo.schedule")).rejects.toThrow(/schedule \(/);
    // 未授权时不挂钟（门禁在 effectiveRegionSchedule，见 scheduler.test.ts）。

    loader.grantCapability("demo.schedule", "schedule");
    await expect(loader.activate("demo.schedule")).resolves.toBeUndefined();
  });

  it('worker 侧 call("schedule") 一律拒绝（宿主驱动的能力）', async () => {
    loader.register(scheduleManifest());
    loader.grantCapability("demo.schedule", "schedule");
    await loader.activate("demo.schedule");
    await expect(loader.callCapability("demo.schedule", "schedule", {})).rejects.toThrow(/host-driven/);
  });

  it("未声明 schedule 的插件激活该能力被拒", async () => {
    loader.register({ ...scheduleManifest("demo.quiet"), requires: ["storage.kv"] });
    loader.grantCapability("demo.quiet", "storage.kv");
    await loader.activate("demo.quiet");
    await expect(loader.callCapability("demo.quiet", "schedule", {})).rejects.toThrow(/not declared/);
  });
});
