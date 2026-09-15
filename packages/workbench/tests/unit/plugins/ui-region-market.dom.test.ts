import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import WorkspaceOverlayRegions from "@/components/WorkspaceOverlayRegions.vue";
import PluginRegionHost from "@/components/PluginRegionHost.vue";
import { createCapabilityLoader } from "@/plugins/loader";
import { setCapabilityLoaderForTest, useCapabilityLoader } from "@/plugins/current";
import { resetPluginRuntime } from "@/plugins/runtime";
import { adaptInstalledPlugin } from "@/plugins/declarative";
import type { DeclarativeValue, InstalledPluginPackage } from "@/plugins/market-types";

/**
 * 市场包 uiRegion 贡献（v2）：worker 包经 adaptInstalledPlugin 把渲染循环挂到
 * workspaceOverlay —— loader 快照出现该浮层；浮层宿主渲染 PluginRegionHost；
 * 动作按钮 invoke worker handler 后 patch 合并进区域持久化状态。
 */

const pluginPackage: InstalledPluginPackage = {
  schemaVersion: 1,
  code: 'greywork.registerAction("draw", () => [{ kind: "circle", cx: 30, cy: 30, r: 20, fill: "#f7c873" }]);',
  manifest: {
    id: "demo.pet",
    name: "桌面宠物",
    version: "1.2.0",
    kind: "worker",
    runtime: {
      type: "worker",
      entry: "https://raw.githubusercontent.com/acme/demo/main/demo.js",
      sha256: "a".repeat(64),
      render: { handler: "draw", fps: 12, width: 160, height: 150 },
    },
    requires: [],
    contributes: {
      modes: [
        {
          id: "demo-pet",
          title: "宠物猫",
          page: { heading: "h", body: "b", fields: [], outputs: [], actions: [] },
        },
      ],
      uiRegions: [
        {
          region: "workspaceOverlay",
          id: "pet.overlay",
          title: "宠物",
          order: 5,
          width: 160,
          height: 150,
          actions: [
            { id: "feed", label: "喂食" },
            { id: "pet", label: "撸猫" },
          ],
        },
      ],
    },
  },
};

/** 假 worker runtime：记录调用，返回可编程结果。 */
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
      dispose: vi.fn(),
    },
    on(handler: string, fn: (state: Record<string, unknown>) => unknown) {
      handlers.set(handler, fn);
    },
  };
}

/** 已挂载的组件：必须在 afterEach 卸载 —— 见 afterEach 里的说明。 */
let mounted: VueWrapper | undefined;

beforeEach(async () => {
  window.localStorage.clear();
  setCapabilityLoaderForTest(createCapabilityLoader());
  resetPluginRuntime();
  const { bootPlugins } = await import("@/plugins/runtime");
  await bootPlugins();
});

afterEach(() => {
  // 显式卸载：PluginRenderLoop 的轮询靠组件卸载清掉（onBeforeUnmount 里 clearInterval）。
  // 不卸载的话定时器会活到 happy-dom 环境拆掉之后，回调读 `document.hidden` 抛
  // ReferenceError —— vitest 会把它报成「test environment torn down 之后的 unhandled error」。
  mounted?.unmount();
  mounted = undefined;
  setCapabilityLoaderForTest(null);
  resetPluginRuntime();
  window.localStorage.clear();
});

describe("市场包 uiRegion 贡献", () => {
  it("adaptInstalledPlugin 把渲染循环区域挂进 loader 快照", async () => {
    const fake = createFakeRuntime();
    fake.on("draw", () => [{ kind: "circle", cx: 30, cy: 30, r: 20 }]);
    fake.on("feed", () => ({ fed: true }));

    const { registerPlugin, setPluginEnabled } = await import("@/plugins/runtime");
    registerPlugin(adaptInstalledPlugin(pluginPackage, fake.runtime));
    await setPluginEnabled("demo.pet", true);

    const loader = useCapabilityLoader();
    const overlayRegions = loader
      .snapshot()
      .uiRegions.filter((region) => region.region === "workspaceOverlay" && region.id === "pet.overlay");
    expect(overlayRegions).toHaveLength(1);
    expect(overlayRegions[0]!.title).toBe("宠物");
  });

  it("区域壳拉取画布指令并通过动作按钮 invoke worker", async () => {
    const fake = createFakeRuntime();
    fake.on("draw", (state) => [{ kind: "circle", cx: 30, cy: 30, r: 20, fill: state?.happy ? "#ff0" : "#f7c873" }]);
    fake.on("feed", () => ({ happy: true }));

    const { registerPlugin, setPluginEnabled } = await import("@/plugins/runtime");
    registerPlugin(adaptInstalledPlugin(pluginPackage, fake.runtime));
    await setPluginEnabled("demo.pet", true);
    await flushPromises();

    const wrapper = mount(WorkspaceOverlayRegions);
    mounted = wrapper;
    // 区域标题出现；壳组件挂载。
    expect(wrapper.text()).toContain("宠物");
    expect(wrapper.findComponent(PluginRegionHost).exists()).toBe(true);
    // 渲染循环开始拉取 draw 指令（异步轮询：等两拍）。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.runtime.invokeRaw).toHaveBeenCalled();
    // 动作按钮存在。
    expect(wrapper.find('[data-testid="region-action-pet.overlay-feed"]').text()).toBe("喂食");

    // 点喂食 → worker handler 被调用 → patch 合并（invoke 返回 happy:true）。
    await wrapper.get('[data-testid="region-action-pet.overlay-feed"]').trigger("click");
    await flushPromises();
    expect(fake.runtime.invoke).toHaveBeenCalledWith("feed", expect.any(Object));
  });
});
