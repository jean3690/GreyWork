import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import PluginRenderCanvas from "@/features/plugins/PluginRenderCanvas.vue";
import PluginRenderLoop from "@/features/plugins/PluginRenderLoop.vue";
import PluginRegionHost from "@/features/plugins/PluginRegionHost.vue";
import { adaptInstalledPlugin } from "@/plugins/declarative";
import type { PluginPointerEvent } from "@/plugins/code-runtime";
import type { DeclarativeValue, InstalledPluginPackage } from "@/plugins/market-types";

/**
 * 渲染指针事件接线（真·Vue）：
 *
 *   manifest.render.pointer=true
 *     → adapter（declarative.ts）给区域宿主接线 dispatchPointer
 *     → PluginRenderLoop 监听画布指针事件、归一化坐标（裁剪 + nx/ny）
 *     → runtime.dispatchPointer（isPatch 校验）
 *     → PluginRegionHost.applyPointerPatch 合并进区域状态 → 下一帧可见
 *
 * worker 侧 prelude（registerPointer）在 pointer-prelude.test.ts 覆盖；这里钉住宿主接线。
 */

const pointerPackage: InstalledPluginPackage = {
  schemaVersion: 1,
  code: `greywork.registerPointer((event) => ({ lastEvent: event.type }));`,
  manifest: {
    id: "demo.pointerx",
    name: "指针演示",
    version: "1.0.0",
    kind: "worker",
    runtime: {
      type: "worker",
      entry: "https://raw.githubusercontent.com/acme/plugins/main/demo.js",
      sha256: "a".repeat(64),
      render: { handler: "draw", fps: 12, width: 220, height: 160, pointer: true },
    },
    requires: [],
    contributes: {
      modes: [],
      uiRegions: [{ region: "workspaceOverlay", id: "ptr.overlay", title: "指针", order: 5, width: 220, height: 160, actions: [] }],
    },
  },
};

function withPointer(pointer: boolean): InstalledPluginPackage {
  return {
    ...pointerPackage,
    manifest: {
      ...pointerPackage.manifest,
      runtime: { ...pointerPackage.manifest.runtime!, render: { ...pointerPackage.manifest.runtime!.render!, pointer } },
    },
  };
}

function createFakeRuntime() {
  const calls: Array<{ event: PluginPointerEvent; state: Readonly<Record<string, DeclarativeValue>> }> = [];
  return {
    calls,
    runtime: {
      invoke: vi.fn(async (): Promise<Record<string, DeclarativeValue> | void> => undefined),
      invokeRaw: vi.fn(async (): Promise<unknown> => []),
      dispatchPointer: vi.fn(async (event: PluginPointerEvent, state: Readonly<Record<string, DeclarativeValue>>) => {
        calls.push({ event, state });
        return { clicks: (typeof state.clicks === "number" ? state.clicks : 0) + 1 };
      }),
      dispose: vi.fn(),
    },
  };
}

/** jsdom 无布局：给画布根节点塞一个可预期的矩形，让宿主坐标换算可断言。 */
function stubCanvasRect(wrapper: VueWrapper, rect: { left: number; top: number; width: number; height: number }): Element {
  const svg = wrapper.findComponent(PluginRenderCanvas).element;
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  } as DOMRect);
  return svg;
}

let mounted: VueWrapper | undefined;

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("渲染指针事件 · 区域接线", () => {
  it("render.pointer=true：归一化事件交给 worker，返回补丁并入区域状态（下一事件可见）", async () => {
    const fake = createFakeRuntime();
    const manifest = adaptInstalledPlugin(pointerPackage, fake.runtime);
    const component = manifest.contributes!.uiRegions![0]!.component!;
    const wrapper = mount(component);
    mounted = wrapper;
    expect(wrapper.findComponent(PluginRegionHost).props("dispatchPointer")).toBeTypeOf("function");
    stubCanvasRect(wrapper, { left: 10, top: 20, width: 220, height: 160 });

    const surface = wrapper.find('[data-testid="plugin-render-loop"]');
    await surface.trigger("pointerdown", { clientX: 65, clientY: 108, buttons: 1, pointerId: 4 });
    await flushPromises();
    await surface.trigger("pointerdown", { clientX: 10, clientY: 20, buttons: 1, pointerId: 5 });
    await flushPromises();

    expect(fake.runtime.dispatchPointer).toHaveBeenCalledTimes(2);
    // 坐标裁到画布内：clientX 65 - left 10 = 55 → nx 0.25；clientY 108 - top 20 = 88 → ny 0.55。
    expect(fake.calls[0]!.event).toEqual({ type: "down", x: 55, y: 88, nx: 0.25, ny: 0.55, buttons: 1, pointerId: 4 });
    // 第二次派发时上一轮的补丁已并入状态（clicks 0→1）：证明 onPointerPatch 落到了同一份状态。
    expect(fake.calls[1]!.state.clicks).toBe(1);
  });

  it("render.pointer 未声明：不接线指针通道，画布事件不派发", async () => {
    const fake = createFakeRuntime();
    const manifest = adaptInstalledPlugin(withPointer(false), fake.runtime);
    const component = manifest.contributes!.uiRegions![0]!.component!;
    const wrapper = mount(component);
    mounted = wrapper;
    expect(wrapper.findComponent(PluginRegionHost).props("dispatchPointer")).toBeUndefined();
    stubCanvasRect(wrapper, { left: 0, top: 0, width: 220, height: 160 });

    await wrapper.find('[data-testid="plugin-render-loop"]').trigger("pointerdown", { clientX: 5, clientY: 5 });
    await flushPromises();

    expect(fake.runtime.dispatchPointer).not.toHaveBeenCalled();
  });
});

describe("渲染指针事件 · 渲染循环宿主", () => {
  it("越界坐标裁剪到画布边界，nx/ny 归一化到 [0,1]", async () => {
    const seen: PluginPointerEvent[] = [];
    const wrapper = mount(PluginRenderLoop, {
      props: {
        render: async () => [],
        handler: "draw",
        state: () => ({}),
        width: 220,
        height: 160,
        pointer: true,
        pointerChannel: async (event: PluginPointerEvent) => {
          seen.push(event);
          return undefined;
        },
      },
    });
    mounted = wrapper;
    stubCanvasRect(wrapper, { left: 10, top: 20, width: 220, height: 160 });
    const surface = wrapper.find('[data-testid="plugin-render-loop"]');

    await surface.trigger("pointermove", { clientX: 999, clientY: -50, buttons: 0 });
    await flushPromises();
    await surface.trigger("pointerup", { clientX: 999, clientY: -50, buttons: 0 });
    await flushPromises();

    expect(seen[0]).toMatchObject({ type: "move", x: 220, y: 0, nx: 1, ny: 0 });
    expect(seen[1]).toMatchObject({ type: "up", x: 220, y: 0, nx: 1, ny: 0 });
  });

  it("pointer 未开启时即使给了通道也不派发", async () => {
    const channel = vi.fn(async () => undefined);
    const wrapper = mount(PluginRenderLoop, {
      props: { render: async () => [], handler: "draw", state: () => ({}), pointer: false, pointerChannel: channel },
    });
    mounted = wrapper;
    stubCanvasRect(wrapper, { left: 0, top: 0, width: 220, height: 160 });

    await wrapper.find('[data-testid="plugin-render-loop"]').trigger("pointerdown", { clientX: 5, clientY: 5 });
    await flushPromises();

    expect(channel).not.toHaveBeenCalled();
  });
});
