import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h } from "vue";
import { createCapabilityLoader } from "@/plugins/loader";
import { setCapabilityLoaderForTest } from "@/plugins/current";
import { registerPlugin, resetPluginRuntime, setPluginEnabled } from "@/plugins/runtime";
import SiderRegions from "@/features/shell/SiderRegions.vue";
import type { PluginManifest, UiRegionContribution } from "@/plugins/types";

/**
 * shellSidebar 宿主：分组按 order 渲染 + 标题小标 + 内容、收尾分隔线；
 * 空快照零渲染（宿主整体不占位）；插件停用分组即消失。overflow 对 shellSidebar 不生效。
 */

function panelStub(label: string) {
  return defineComponent({ render: () => h("div", { "data-testid": `sider-panel-${label}` }, label) });
}

function group(id: string, extra: Partial<UiRegionContribution> = {}): UiRegionContribution {
  return { region: "shellSidebar", id, title: id, component: panelStub(id), ...extra };
}

function plugin(id: string, groups: UiRegionContribution[]): PluginManifest {
  return { id, name: id, version: "1.0.0", contributes: { uiRegions: groups } };
}

async function enable(id: string): Promise<void> {
  await setPluginEnabled(id, true);
  await flushPromises();
}

async function disable(id: string): Promise<void> {
  await setPluginEnabled(id, false);
  await flushPromises();
}

function mountHost(): ReturnType<typeof mount> {
  return mount(SiderRegions);
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

describe("SiderRegions", () => {
  it("分组按 order 升序渲染：标题 + 内容 + 收尾分隔线", async () => {
    registerPlugin(
      plugin("ext.demo", [
        group("grp.second", { order: 2 }),
        group("grp.first", { order: 1 }),
        group("grp.overflow-marked", { order: 0, overflow: true }), // overflow 对 shellSidebar 不生效，照常成组
      ]),
    );
    await enable("ext.demo");
    const wrapper = mountHost();

    // 标题小标按 order 升序：order 0 → 1 → 2（overflow 标记对 shellSidebar 不生效，照常成组）
    expect(
      ["grp.overflow-marked", "grp.first", "grp.second"].map((id) => wrapper.get(`[data-testid="sider-region-${id}"]`).text()),
    ).toEqual(["grp.overflow-marked", "grp.first", "grp.second"]);
    // 每组内容都渲染（分组宿主无激活概念）；收尾分隔线随宿主渲染
    expect(wrapper.find('[data-testid="sider-panel-grp.first"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sider-panel-grp.second"]').exists()).toBe(true);
    expect(wrapper.findAll("div.h-px").length).toBe(1);
  });

  it("无贡献：宿主零渲染", async () => {
    const wrapper = mountHost();
    expect(wrapper.find('[data-testid="sider-regions"]').exists()).toBe(false);
    expect(wrapper.findAll("div.h-px").length).toBe(0);
  });

  it("插件停用 → 分组消失，宿主回到零渲染", async () => {
    registerPlugin(plugin("ext.demo", [group("grp.only")]));
    await enable("ext.demo");
    const wrapper = mountHost();
    expect(wrapper.find('[data-testid="sider-panel-grp.only"]').exists()).toBe(true);

    await disable("ext.demo");
    expect(wrapper.find('[data-testid="sider-regions"]').exists()).toBe(false);
  });
});
