import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { beforeEach, describe, expect, it } from "vitest";
import { createCapabilityLoader } from "@/plugins/loader";
import { setCapabilityLoaderForTest } from "@/plugins/current";
import { i18n } from "@/i18n";
import PluginStatusBar from "@/features/shell/PluginStatusBar.vue";
import { pluginStatusText, resetPluginStatusForTest, setPluginStatus } from "@/plugins/status";
import type { PluginManifest } from "@/plugins/types";

/**
 * 外壳状态栏：
 *  - 只有激活插件声明了 statusBar 才渲染（空态时整个条不出现）；
 *  - 文案优先 worker 的 setStatus 更新，回落 manifest 的初始 label；
 *  - 点击条目跳到插件自己的页面。
 */

const Dummy = { render: () => null };
const statusPlugin = (id: string, label: string): PluginManifest => ({
  id,
  name: id,
  version: "0.1.0",
  contributes: {
    modes: [{ id: `${id}-page`, title: id, component: Dummy }],
    statusBar: [{ id: "sync", label, modeId: `${id}-page`, pluginId: id }],
  },
});

let router: Router;

beforeEach(async () => {
  resetPluginStatusForTest();
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: Dummy },
      { path: "/plugin/:id", component: Dummy },
    ],
  });
});

async function mountBar(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(PluginStatusBar, { global: { plugins: [i18n, router] } });
  await flushPromises();
  return wrapper;
}

describe("PluginStatusBar", () => {
  it("没有声明时整条不渲染", async () => {
    const loader = createCapabilityLoader();
    setCapabilityLoaderForTest(loader);
    loader.register(statusPlugin("ext.s", "上次成功"));
    // 不激活：快照里没有条目。
    const wrapper = await mountBar();
    expect(wrapper.find('[data-testid="plugin-status-bar"]').exists()).toBe(false);
  });

  it("激活后显示初始 label；setStatus 的文本优先", async () => {
    const loader = createCapabilityLoader();
    setCapabilityLoaderForTest(loader);
    loader.register(statusPlugin("ext.s", "上次成功 10:24"));
    await loader.activate("ext.s");

    const wrapper = await mountBar();
    const bar = wrapper.get('[data-testid="plugin-status-bar"]');
    expect(bar.text()).toContain("上次成功 10:24");

    setPluginStatus("ext.s", "sync", "同步中…");
    await wrapper.vm.$nextTick();
    expect(bar.text()).toContain("同步中…");
  });

  it("点击条目跳到插件页", async () => {
    const loader = createCapabilityLoader();
    setCapabilityLoaderForTest(loader);
    loader.register(statusPlugin("ext.s", "上次成功"));
    await loader.activate("ext.s");
    await router.push("/");

    const wrapper = await mountBar();
    await wrapper.get('[data-testid="plugin-status-ext.s-sync"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe("/plugin/ext.s-page");
  });

  it("pluginStatusText 对未更新条目回落 undefined（由模板回落初始 label）", () => {
    resetPluginStatusForTest();
    expect(pluginStatusText("ext.s", "sync")).toBeUndefined();
  });
});
