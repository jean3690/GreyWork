/**
 * 设备分级：探测信号 → data-perf 落地，以及"只降不升"的单调性。
 *
 * 单调性是这里最容易被改坏的一条：渲染端与宿主两层信息先后到达，若允许回退，
 * 首帧后的一次降级→升级会让动效与虚拟化参数来回切，反而制造卡顿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DeviceTierModule from "@/lib/device-tier";

/** 每个用例都从干净模块开始：deviceTier 是模块级 ref，跨用例会串。 */
async function freshModule(): Promise<typeof DeviceTierModule> {
  vi.resetModules();
  return await import("@/lib/device-tier");
}

function stubNavigator(props: { deviceMemory?: number; hardwareConcurrency?: number }): void {
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
  }
}

const originalDeviceMemory = Object.getOwnPropertyDescriptor(navigator, "deviceMemory");
const originalCores = Object.getOwnPropertyDescriptor(navigator, "hardwareConcurrency");

beforeEach(() => {
  delete (navigator as unknown as Record<string, unknown>).deviceMemory;
  delete document.documentElement.dataset.perf;
});

afterEach(() => {
  if (originalDeviceMemory) Object.defineProperty(navigator, "deviceMemory", originalDeviceMemory);
  else delete (navigator as unknown as Record<string, unknown>).deviceMemory;
  if (originalCores) Object.defineProperty(navigator, "hardwareConcurrency", originalCores);
  else delete (navigator as unknown as Record<string, unknown>).hardwareConcurrency;
  delete document.documentElement.dataset.perf;
});

describe("设备分级", () => {
  it("无任何信号：保持 standard，并显式写 data-perf", async () => {
    const { initDeviceTier, deviceTier } = await freshModule();
    initDeviceTier();
    expect(deviceTier.value).toBe("standard");
    expect(document.documentElement.dataset.perf).toBe("standard");
  });

  it("低内存（<=4GiB）判为 low", async () => {
    stubNavigator({ deviceMemory: 4, hardwareConcurrency: 8 });
    const { initDeviceTier, deviceTier } = await freshModule();
    initDeviceTier();
    expect(deviceTier.value).toBe("low");
    expect(document.documentElement.dataset.perf).toBe("low");
  });

  it("少核（<=2）判为 low", async () => {
    stubNavigator({ deviceMemory: 16, hardwareConcurrency: 2 });
    const { initDeviceTier, deviceTier } = await freshModule();
    initDeviceTier();
    expect(deviceTier.value).toBe("low");
  });

  it("充足内存与核数：standard", async () => {
    stubNavigator({ deviceMemory: 8, hardwareConcurrency: 16 });
    const { initDeviceTier, deviceTier } = await freshModule();
    initDeviceTier();
    expect(deviceTier.value).toBe("standard");
  });

  it("宿主快照（WebKitGTK 场景）把 standard 升级为 low", async () => {
    // WebKitGTK 没有 deviceMemory，只剩核数；内存只能靠宿主。
    stubNavigator({ hardwareConcurrency: 8 });
    const { initDeviceTier, refineDeviceTierFromHost, deviceTier } = await freshModule();
    initDeviceTier();
    expect(deviceTier.value).toBe("standard");
    refineDeviceTierFromHost({ totalMemoryBytes: 2 * 1024 ** 3, cpuCount: 8 });
    expect(deviceTier.value).toBe("low");
    expect(document.documentElement.dataset.perf).toBe("low");
  });

  it("宿主核数不足也升级为 low", async () => {
    stubNavigator({ hardwareConcurrency: 8 });
    const { initDeviceTier, refineDeviceTierFromHost, deviceTier } = await freshModule();
    initDeviceTier();
    refineDeviceTierFromHost({ totalMemoryBytes: 32 * 1024 ** 3, cpuCount: 1 });
    expect(deviceTier.value).toBe("low");
  });

  it("单调性：已判 low 后，充足的宿主信号不把它降回 standard", async () => {
    stubNavigator({ deviceMemory: 2, hardwareConcurrency: 8 });
    const { initDeviceTier, refineDeviceTierFromHost, deviceTier } = await freshModule();
    initDeviceTier();
    expect(deviceTier.value).toBe("low");
    refineDeviceTierFromHost({ totalMemoryBytes: 64 * 1024 ** 3, cpuCount: 32 });
    expect(deviceTier.value).toBe("low");
    expect(document.documentElement.dataset.perf).toBe("low");
  });

  it("缺字段的宿主快照被跳过，不误判", async () => {
    stubNavigator({ deviceMemory: 8, hardwareConcurrency: 16 });
    const { initDeviceTier, refineDeviceTierFromHost, deviceTier } = await freshModule();
    initDeviceTier();
    refineDeviceTierFromHost({ totalMemoryBytes: null, cpuCount: null });
    expect(deviceTier.value).toBe("standard");
  });
});
