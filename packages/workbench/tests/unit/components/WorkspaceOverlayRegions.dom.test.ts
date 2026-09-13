import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import WorkspaceOverlayRegions from "@/components/WorkspaceOverlayRegions.vue";
import { createCapabilityLoader } from "@/plugins/loader";
import { setCapabilityLoaderForTest } from "@/plugins/current";
import { registerPlugin, resetPluginRuntime, setPluginEnabled } from "@/plugins/runtime";

const OverlayContent = defineComponent({ render: () => h("div", { "data-testid": "cat-content" }, "cat") });

beforeEach(async () => {
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  setCapabilityLoaderForTest(createCapabilityLoader());
  resetPluginRuntime();
  registerPlugin({
    id: "demo.pet",
    name: "猫",
    version: "1.0.0",
    contributes: {
      uiRegions: [{ region: "workspaceOverlay", id: "pet.overlay", title: "宠物", component: OverlayContent }],
    },
  });
  await setPluginEnabled("demo.pet", true);
});

afterEach(() => {
  setCapabilityLoaderForTest(null);
  resetPluginRuntime();
  window.localStorage.clear();
});

describe("WorkspaceOverlayRegions", () => {
  it("以 fixed 浮层渲染，不参与工作台布局", async () => {
    const wrapper = mount(WorkspaceOverlayRegions);
    await flushPromises();

    const overlay = wrapper.get('[data-testid="workspace-overlay-pet.overlay"]');
    expect(overlay.classes()).toContain("fixed");
    expect(wrapper.find('[data-testid="cat-content"]').exists()).toBe(true);
  });

  it("拖动标题条更新位置并持久化", async () => {
    const wrapper = mount(WorkspaceOverlayRegions);
    await flushPromises();
    const overlay = wrapper.get('[data-testid="workspace-overlay-pet.overlay"]');
    const overlayElement = overlay.element as HTMLElement;
    const handle = wrapper.get('[data-testid="workspace-overlay-handle-pet.overlay"]');
    const initialLeft = Number.parseFloat(overlayElement.style.left);
    const initialTop = Number.parseFloat(overlayElement.style.top);

    await handle.trigger("pointerdown", { button: 0, pointerId: 7, clientX: 100, clientY: 100 });
    overlayElement.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: 60, clientY: 70 }));
    overlayElement.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, clientX: 60, clientY: 70 }));
    await flushPromises();

    expect(Number.parseFloat(overlayElement.style.left)).toBe(initialLeft - 40);
    expect(Number.parseFloat(overlayElement.style.top)).toBe(initialTop - 30);
    expect(JSON.parse(window.localStorage.getItem("greywork:overlay-position:pet.overlay") ?? "null")).toEqual({
      left: initialLeft - 40,
      top: initialTop - 30,
    });
  });
});
