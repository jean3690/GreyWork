import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createCapabilityLoader } from "@/plugins/loader";
import { setCapabilityLoaderForTest } from "@/plugins/current";
import { resetPluginRuntime } from "@/plugins/runtime";
import PluginsView from "@/views/PluginsView.vue";
import PluginView from "@/views/PluginView.vue";
import Sider from "@/components/Sider.vue";
import { createAppRouter } from "@/router";

/**
 * 微内核接线的 UI 面：插件中心（本身是内置插件贡献的模式页）能列出并启停插件；
 * 停用后 seam 快照里的 modes 实时消失；/plugin/:id 宿主能渲染贡献组件、未知 id 回退；
 * 侧栏快捷入口合并插件贡献的 modes。
 */
function workspace(id: string, name: string) {
  return { id, name, description: "", folder: undefined, files: [], createdAt: 1, updatedAt: 1, lastUsedAt: 1 };
}

function seedShellStorage(): void {
  window.localStorage.setItem(
    "greywork.workspaces",
    JSON.stringify({ version: 2, workspaces: [workspace("w-alpha", "Alpha 仓")], activeWorkspaceId: "w-alpha", defaultWorkspaceId: null }),
  );
  window.localStorage.setItem("greywork.sessions", JSON.stringify({ version: 2, sessions: [], activeSessionId: null }));
}

async function bootWithFreshLoader(): Promise<void> {
  setCapabilityLoaderForTest(createCapabilityLoader());
  resetPluginRuntime();
  const { bootPlugins } = await import("@/plugins/runtime");
  await bootPlugins();
}

beforeEach(() => {
  window.localStorage.clear();
  seedShellStorage();
  setActivePinia(createPinia());
});

afterEach(() => {
  setCapabilityLoaderForTest(null);
  resetPluginRuntime();
  window.localStorage.clear();
});

describe("PluginsView（插件中心自身）", () => {
  it("列出内置清单并显示当前启停状态", async () => {
    await bootWithFreshLoader();
    const wrapper = mount(PluginsView);

    expect(wrapper.text()).toContain("插件中心");
    expect(wrapper.get('[data-testid="plugin-card-core.plugins"]').text()).toContain("core.plugins");
    const toggle = wrapper.get('[data-testid="plugin-toggle-core.plugins"]');
    expect(toggle.text()).toBe("停用");
    expect(toggle.attributes("aria-pressed")).toBe("true");
    expect(wrapper.get('[data-testid="mode-chip-plugins"]').text()).toBe("插件");
  });

  it("停用后自身贡献的模式页从 seam 快照消失，按钮翻转为「启用」", async () => {
    await bootWithFreshLoader();
    const wrapper = mount(PluginsView);

    await wrapper.get('[data-testid="plugin-toggle-core.plugins"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="plugin-toggle-core.plugins"]').text()).toBe("启用");
    expect(wrapper.find('[data-testid="mode-chip-plugins"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("已停用 core.plugins");
  });
});

describe("PluginView（/plugin/:id 宿主）", () => {
  it("活跃模式贡献可渲染；未知 id 给回退提示", async () => {
    await bootWithFreshLoader();
    const router = createAppRouter();
    const wrapper = mount(PluginView, { global: { plugins: [router] } });
    await router.push("/plugin/plugins");
    await router.isReady();
    await flushPromises();
    await flushPromises();
    expect(wrapper.text()).toContain("插件中心");

    await router.push("/plugin/does-not-exist");
    await flushPromises();
    expect(wrapper.text()).toContain("已被停用");
    expect(wrapper.text()).toContain("does-not-exist");
  });
});

describe("Sider 快捷入口", () => {
  it("内置插件激活后，侧栏出现插件入口；停用后消失", async () => {
    await bootWithFreshLoader();
    const router = createAppRouter();
    await router.push("/guid");
    await router.isReady();

    const wrapper = mount(Sider, {
      props: { collapsed: false, theme: "dark", lastNonSettingsPath: "/guid" },
      global: { plugins: [router] },
    });

    const pluginButtons = wrapper.findAll("button").filter((button) => button.text().trim() === "插件");
    expect(pluginButtons.length).toBe(1);

    // 停用内置插件 → seam modes 清空 → 入口消失
    const { setPluginEnabled } = await import("@/plugins/runtime");
    await setPluginEnabled("core.plugins", false);
    await flushPromises();
    const after = wrapper.findAll("button").filter((button) => button.text().trim() === "插件");
    expect(after.length).toBe(0);
  });
});
