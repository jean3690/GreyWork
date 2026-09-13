import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h } from "vue";
import { createCapabilityLoader } from "@/plugins/loader";
import { setCapabilityLoaderForTest } from "@/plugins/current";
import { registerPlugin, resetPluginRuntime, setPluginEnabled } from "@/plugins/runtime";
import ActivityBand from "@/components/activity/ActivityBand.vue";
import type { PluginManifest, UiRegionContribution } from "@/plugins/types";

/**
 * activityPanel 宿主：常驻页签排序/激活/内容切换、「更多」下拉、插件停用即整条消失、
 * 激活回退、折叠保挂载、持久化 prefs 生效。不 boot 内置清单 —— 只用测试插件隔离贡献，
 * 避免 core.artifacts 的「产物」页签混入断言。
 */

function panelStub(label: string) {
  return defineComponent({ render: () => h("div", { "data-testid": `panel-${label}` }, label) });
}

function region(id: string, extra: Partial<UiRegionContribution> = {}): UiRegionContribution {
  return { region: "activityPanel", id, title: id, component: panelStub(id), ...extra };
}

function plugin(id: string, regions: UiRegionContribution[]): PluginManifest {
  return { id, name: id, version: "1.0.0", contributes: { uiRegions: regions } };
}

async function enable(id: string): Promise<void> {
  await setPluginEnabled(id, true);
  await flushPromises();
}

async function disable(id: string): Promise<void> {
  await setPluginEnabled(id, false);
  await flushPromises();
}

function mountBand(): ReturnType<typeof mount> {
  // 不额外装 pinia：组件与测试共享 beforeEach 里 setActivePinia 的同一实例
  return mount(ActivityBand);
}

function tabTexts(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('[data-testid="activity-tab"]').map((tab) => tab.text());
}

beforeEach(() => {
  window.localStorage.clear();
  setCapabilityLoaderForTest(createCapabilityLoader());
  resetPluginRuntime();
  setActivePinia(createPinia());
});

afterEach(() => {
  setCapabilityLoaderForTest(null);
  resetPluginRuntime();
  window.localStorage.clear();
});

describe("ActivityBand", () => {
  it("页签按 order 升序、overflow 贡献收进「更多」不占条位", async () => {
    registerPlugin(
      plugin("ext.demo", [region("tab.alpha", { order: 2 }), region("tab.gamma", { overflow: true }), region("tab.beta", { order: 1 })]),
    );
    await enable("ext.demo");
    const wrapper = mountBand();

    expect(tabTexts(wrapper)).toEqual(["tab.beta", "tab.alpha"]);
    expect(wrapper.findAll('[data-testid="activity-overflow-item"]')).toHaveLength(0);
    expect(wrapper.get('[data-testid="activity-band"]').attributes("style")).toContain("height: 0px");
  });

  it("默认激活首个常驻页签并渲染其内容", async () => {
    registerPlugin(plugin("ext.demo", [region("tab.alpha", { order: 2 }), region("tab.beta", { order: 1 })]));
    await enable("ext.demo");
    const wrapper = mountBand();
    const { useActivityStore } = await import("@/stores/activity");
    useActivityStore().setOpen(true);
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('[data-testid^="panel-"]').map((node) => node.attributes("data-testid"))).toEqual(["panel-tab.beta"]);
  });

  it("点击页签切换激活内容", async () => {
    registerPlugin(plugin("ext.demo", [region("tab.alpha"), region("tab.beta")]));
    await enable("ext.demo");
    const wrapper = mountBand();
    const { useActivityStore } = await import("@/stores/activity");
    useActivityStore().setOpen(true);
    await wrapper.vm.$nextTick();

    const tabs = wrapper.findAll('[data-testid="activity-tab"]');
    await tabs.find((tab) => tab.text() === "tab.alpha")!.trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('[data-testid^="panel-"]').map((node) => node.attributes("data-testid"))).toEqual(["panel-tab.alpha"]);
  });

  it("「更多」下拉列出 overflow 贡献，点选后激活并收起菜单", async () => {
    registerPlugin(plugin("ext.demo", [region("tab.alpha"), region("tab.gamma", { overflow: true })]));
    await enable("ext.demo");
    const wrapper = mountBand();
    const { useActivityStore } = await import("@/stores/activity");
    useActivityStore().setOpen(true);
    await wrapper.vm.$nextTick();

    await wrapper.get('[data-testid="activity-overflow-toggle"]').trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="activity-overflow-item"]').map((item) => item.text())).toEqual(["tab.gamma"]);

    await wrapper.get('[data-testid="activity-overflow-item"]').trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid^="panel-"]').map((node) => node.attributes("data-testid"))).toEqual(["panel-tab.gamma"]);
    expect(wrapper.find('[data-testid="activity-overflow-menu"]').exists()).toBe(false);
  });

  it("点条带外空白处收起「更多」菜单", async () => {
    registerPlugin(plugin("ext.demo", [region("tab.alpha"), region("tab.gamma", { overflow: true })]));
    await enable("ext.demo");
    const wrapper = mountBand();

    await wrapper.get('[data-testid="activity-overflow-toggle"]').trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="activity-overflow-menu"]').exists()).toBe(true);

    // 点条带外空白处：happy-dom 不把元素上派发的事件送回 window 捕获期，
    // 这里在 document.body 上派发等效的「条带外 pointerdown」。
    const EventCtor = (typeof PointerEvent !== "undefined" ? PointerEvent : Event) as typeof Event;
    document.body.dispatchEvent(new EventCtor("pointerdown", { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="activity-overflow-menu"]').exists()).toBe(false);
  });

  it("最后一个 overflow 项随插件停用消失时，菜单空壳自动收起", async () => {
    registerPlugin(plugin("ext.demo", [region("tab.alpha"), region("tab.gamma", { overflow: true })]));
    await enable("ext.demo");
    const wrapper = mountBand();

    await wrapper.get('[data-testid="activity-overflow-toggle"]').trigger("click");
    await wrapper.vm.$nextTick();
    await disable("ext.demo");
    expect(wrapper.find('[data-testid="activity-overflow-menu"]').exists()).toBe(false);
  });

  it("插件停用 → 整条带消失；无贡献时即使 prefs 打开也不渲染", async () => {
    registerPlugin(plugin("ext.demo", [region("tab.alpha")]));
    await enable("ext.demo");
    const { useActivityStore } = await import("@/stores/activity");
    const store = useActivityStore();
    store.setOpen(true);
    const wrapper = mountBand();
    expect(wrapper.find('[data-testid="activity-band"]').exists()).toBe(true);

    await disable("ext.demo");
    expect(wrapper.find('[data-testid="activity-band"]').exists()).toBe(false);
  });

  it("激活页签的插件被停 → 回退首个常驻页签，不崩", async () => {
    registerPlugin(plugin("ext.alpha", [region("tab.alpha")]));
    registerPlugin(plugin("ext.beta", [region("tab.beta")]));
    await enable("ext.alpha");
    await enable("ext.beta");
    const wrapper = mountBand();
    const { useActivityStore } = await import("@/stores/activity");
    useActivityStore().setOpen(true);
    await wrapper.vm.$nextTick();

    await wrapper
      .findAll('[data-testid="activity-tab"]')
      .find((tab) => tab.text() === "tab.beta")!
      .trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="panel-tab.beta"]').exists()).toBe(true);

    await disable("ext.beta");
    expect(wrapper.find('[data-testid="panel-tab.beta"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="panel-tab.alpha"]').exists()).toBe(true);
  });

  it("折叠：高度归零、aria-hidden、内容保持挂载", async () => {
    registerPlugin(plugin("ext.demo", [region("tab.alpha")]));
    await enable("ext.demo");
    const wrapper = mountBand();
    const { useActivityStore } = await import("@/stores/activity");
    const store = useActivityStore();
    store.setOpen(true);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="panel-tab.alpha"]').exists()).toBe(true);
    await wrapper.get('[data-testid="activity-collapse"]').trigger("click");
    await wrapper.vm.$nextTick();

    expect(store.open).toBe(false);
    const band = wrapper.get('[data-testid="activity-band"]');
    expect(band.attributes("style")).toContain("height: 0px");
    expect(band.attributes("aria-hidden")).toBe("true");
    // 内容区 v-show 隐藏但 stub 仍挂载（收起不卸载）
    expect(wrapper.find('[data-testid="panel-tab.alpha"]').exists()).toBe(true);
  });

  it("持久化 prefs 生效：存档 open + active 在挂载时还原", async () => {
    registerPlugin(plugin("ext.demo", [region("tab.alpha", { order: 2 }), region("tab.beta", { order: 1 })]));
    await enable("ext.demo");
    window.localStorage.setItem("greywork.activity.band", JSON.stringify({ open: true, active: "tab.alpha" }));
    const wrapper = mountBand();

    expect(wrapper.get('[data-testid="activity-band"]').attributes("style")).toContain("height: 220px");
    expect(wrapper.find('[data-testid="panel-tab.alpha"]').exists()).toBe(true);
  });

  it("窄屏（available=false）不渲染整条带", async () => {
    registerPlugin(plugin("ext.demo", [region("tab.alpha")]));
    await enable("ext.demo");
    const { useActivityStore } = await import("@/stores/activity");
    useActivityStore().setAvailable(false);
    const wrapper = mountBand();
    expect(wrapper.find('[data-testid="activity-band"]').exists()).toBe(false);
  });
});
