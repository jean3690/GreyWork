import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createCapabilityLoader } from "@/plugins/loader";
import { setCapabilityLoaderForTest } from "@/plugins/current";
import { resetPluginRuntime } from "@/plugins/runtime";
import { adaptInstalledPlugin } from "@/plugins/declarative";
import type { DeclarativeValue, InstalledPluginPackage } from "@/plugins/market-types";

/**
 * 脱窗能力（window.floating）UI 面：
 * - 适配层把 window 声明传给区域宿主；
 * - 「弹出桌面」按钮仅在插件声明 window 且能力已授权时出现；
 * - 未授权时按钮隐藏（门禁先于命令）。
 */

const windowPluginPackage: InstalledPluginPackage = {
  schemaVersion: 1,
  code: 'greywork.registerAction("draw", () => []);',
  manifest: {
    id: "demo.pet",
    name: "桌面宠物",
    version: "1.3.0",
    kind: "worker",
    runtime: {
      type: "worker",
      entry: "https://raw.githubusercontent.com/acme/demo/main/demo.js",
      sha256: "a".repeat(64),
      render: { handler: "draw", fps: 12, width: 200, height: 200 },
    },
    requires: ["window.floating"],
    window: { width: 200, height: 200 },
    contributes: {
      modes: [{ id: "demo-pet", title: "宠物猫", page: { heading: "h", body: "b", fields: [], outputs: [], actions: [] } }],
      uiRegions: [{ region: "shellSidebar", id: "pet.sidebar", title: "宠物", order: 5, actions: [] }],
    },
  },
};

const plainPluginPackage: InstalledPluginPackage = {
  ...windowPluginPackage,
  manifest: {
    ...windowPluginPackage.manifest,
    id: "demo.plain",
    requires: [],
    window: undefined,
    contributes: {
      modes: windowPluginPackage.manifest.contributes.modes,
      uiRegions: [{ region: "shellSidebar", id: "plain.sidebar", title: "无窗插件", order: 6, actions: [] }],
    },
  },
};

function mountRegion(pluginPackage: InstalledPluginPackage) {
  const manifest = adaptInstalledPlugin(pluginPackage, {
    invoke: vi.fn(async (): Promise<Record<string, DeclarativeValue> | void> => undefined),
    invokeRaw: vi.fn(async (): Promise<unknown> => []),
    dispose: vi.fn(),
  });
  const uiRegion = manifest.contributes!.uiRegions![0]!;
  return { uiRegion, component: uiRegion.component };
}

const wrappers: ReturnType<typeof mount>[] = [];

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  setCapabilityLoaderForTest(createCapabilityLoader());
  resetPluginRuntime();
});

afterEach(() => {
  for (const w of wrappers) w.unmount();
  wrappers.length = 0;
  setCapabilityLoaderForTest(null);
  resetPluginRuntime();
  window.localStorage.clear();
});

describe("window.floating 脱窗门禁", () => {
  it("声明 window + 授权后，区域宿主显示「弹出桌面」按钮", async () => {
    const { bootPlugins, grantPluginCapability } = await import("@/plugins/runtime");
    await bootPlugins();
    grantPluginCapability("window.floating");
    const { component } = mountRegion(windowPluginPackage);
    const wrapper = mount(component);
    wrappers.push(wrapper);

    expect(wrapper.find('[data-testid="plugin-window-open-demo.pet"]').exists()).toBe(true);
  });

  it("声明 window 但未授权：按钮不出现（门禁先于命令）", async () => {
    const { bootPlugins } = await import("@/plugins/runtime");
    await bootPlugins();
    const { component } = mountRegion(windowPluginPackage);
    const wrapper = mount(component);
    wrappers.push(wrapper);
    expect(wrapper.find('[data-testid="plugin-window-open-demo.pet"]').exists()).toBe(false);
  });

  it("未声明 window 的插件：永不出现脱窗按钮", async () => {
    const { bootPlugins, grantPluginCapability } = await import("@/plugins/runtime");
    await bootPlugins();
    grantPluginCapability("window.floating");
    const { component } = mountRegion(plainPluginPackage);
    const wrapper = mount(component);
    wrappers.push(wrapper);
    expect(wrapper.find('[data-testid="plugin-window-open-demo.plain"]').exists()).toBe(false);
  });
});
