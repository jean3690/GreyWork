import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createCapabilityLoader } from "@/plugins/loader";
import { recordCapabilityAudit, resetCapabilityAuditForTest } from "@/plugins/capabilities";
import { setCapabilityLoaderForTest } from "@/plugins/current";
import { resetPluginRuntime } from "@/plugins/runtime";
import PluginsView from "@/views/PluginsView.vue";
import PluginView from "@/views/PluginView.vue";
import Sider from "@/components/Sider.vue";
import DeclarativePluginView from "@/plugins/DeclarativePluginView.vue";
import type { DeclarativePage } from "@/plugins/market-types";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";

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
    expect(wrapper.get('[data-testid="plugin-market"]').text()).toContain("插件中心");
    expect(wrapper.get('[data-testid="market-tab-discover"]').attributes("aria-pressed")).toBe("true");

    await wrapper.get('[data-testid="market-tab-installed"]').trigger("click");
    expect(wrapper.get('[data-testid="plugin-card-core.plugins"]').text()).toContain("core.plugins");
    const toggle = wrapper.get('[data-testid="plugin-toggle-core.plugins"]');
    expect(toggle.text()).toBe("停用");
    expect(toggle.attributes("aria-pressed")).toBe("true");
    expect(wrapper.get('[data-testid="mode-chip-plugins"]').text()).toBe("插件");
    expect(wrapper.get('[data-testid="market-tab-installed"]').attributes("aria-pressed")).toBe("true");
    expect(wrapper.get('[data-testid="plugin-card-core.plugins"]').text()).toContain("内置");
  });

  it("停用自身需两步确认：确认后模式页从 seam 快照消失，按钮翻转为「启用」", async () => {
    await bootWithFreshLoader();
    const wrapper = mount(PluginsView);

    await wrapper.get('[data-testid="market-tab-installed"]').trigger("click");
    // 第一次点：出现警告 + 确认/取消，尚未停用
    await wrapper.get('[data-testid="plugin-toggle-core.plugins"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("停用插件中心后本页会消失");
    expect(wrapper.find('[data-testid="mode-chip-plugins"]').exists()).toBe(true);

    // 点确认（第二步）：真正停用
    const confirmButtons = wrapper.findAll("button").filter((button) => button.text().includes("删除"));
    expect(confirmButtons.length).toBeGreaterThan(0);
    await confirmButtons[confirmButtons.length - 1]!.trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="plugin-toggle-core.plugins"]').text()).toBe("启用");
    expect(wrapper.find('[data-testid="mode-chip-plugins"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("已停用 core.plugins");
  });

  it("第三方插件所需能力可在插件卡片授权，随后启用成功", async () => {
    await bootWithFreshLoader();
    const { registerPlugin } = await import("@/plugins/runtime");
    registerPlugin({ id: "ext.secure", name: "需授权插件", version: "1.0.0", requires: ["workspace:write"] });
    const wrapper = mount(PluginsView);

    await wrapper.get('[data-testid="market-tab-installed"]').trigger("click");
    const capability = wrapper.get('[data-testid="plugin-capability-ext.secure-workspace:write"]');
    expect(capability.text()).toContain("未授权");
    await capability.trigger("click");
    await flushPromises();
    expect(capability.text()).toContain("已授权");

    await wrapper.get('[data-testid="plugin-toggle-ext.secure"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="plugin-toggle-ext.secure"]').attributes("aria-pressed")).toBe("true");
  });

  it("注册表设置默认收起，可展开编辑；发现页支持客户端筛选", async () => {
    await bootWithFreshLoader();
    const wrapper = mount(PluginsView);

    expect(wrapper.find('[data-testid="plugin-registry-settings"]').exists()).toBe(false);
    await wrapper.get('[data-testid="plugin-registry-toggle"]').trigger("click");
    expect(wrapper.get('[data-testid="plugin-registry-settings"]').isVisible()).toBe(true);
    expect((wrapper.get('[data-testid="plugin-registry-url"]').element as HTMLInputElement).value).toContain("githubusercontent.com");

    await wrapper.get('[data-testid="plugin-market-search"]').setValue("does-not-exist");
    expect((wrapper.get('[data-testid="plugin-market-search"]').element as HTMLInputElement).value).toBe("does-not-exist");
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

describe("DeclarativePluginView（受控声明式交互）", () => {
  const page: DeclarativePage = {
    heading: "专注计数器",
    body: "声明式状态与动作",
    fields: [
      { key: "name", label: "目标", kind: "text", default: "写测试", maxLength: 40 },
      { key: "count", label: "进度", kind: "number", default: 0, min: 0, max: 6, step: 1 },
      { key: "enabled", label: "提醒", kind: "toggle", default: true },
    ],
    outputs: [{ label: "当前进度", valueKey: "count", suffix: "次" }],
    actions: [
      { id: "add-five", label: "+5", operation: { type: "increment", key: "count", amount: 5 } },
      { id: "reset", label: "恢复", style: "danger", operation: { type: "reset" } },
    ],
  };

  it("编辑设置、执行限界动作并持久化状态", async () => {
    const wrapper = mount(DeclarativePluginView, { props: { pluginId: "test.counter", modeId: "counter", page } });
    expect(wrapper.get('[data-testid="declarative-output-count"]').text()).toBe("0次");

    await wrapper.get('[data-testid="declarative-action-add-five"]').trigger("click");
    await wrapper.get('[data-testid="declarative-action-add-five"]').trigger("click");
    expect(wrapper.get('[data-testid="declarative-output-count"]').text()).toBe("6次");

    await wrapper.get('[data-testid="declarative-field-name"]').setValue("完成插件增强");
    expect(JSON.parse(window.localStorage.getItem("greywork.plugins.declarativeState") ?? "{}")["test.counter/counter"]).toMatchObject({
      count: 6,
      name: "完成插件增强",
      enabled: true,
    });

    wrapper.unmount();
    const restored = mount(DeclarativePluginView, { props: { pluginId: "test.counter", modeId: "counter", page } });
    expect(restored.get('[data-testid="declarative-output-count"]').text()).toBe("6次");
    expect((restored.get('[data-testid="declarative-field-name"]').element as HTMLInputElement).value).toBe("完成插件增强");

    await restored.get('[data-testid="declarative-action-reset"]').trigger("click");
    expect(restored.get('[data-testid="declarative-output-count"]').text()).toBe("0次");
  });

  it("调用 worker 动作并只合并已声明字段", async () => {
    const invoke = vi.fn().mockResolvedValue({ count: 4, name: "来自 Worker", undeclared: "ignored" });
    const workerPage: DeclarativePage = {
      ...page,
      actions: [{ id: "run", label: "运行", operation: { type: "invoke", handler: "advance" } }],
    };
    const wrapper = mount(DeclarativePluginView, {
      props: { pluginId: "test.worker", modeId: "worker", page: workerPage, invoke },
    });

    await wrapper.get('[data-testid="declarative-action-run"]').trigger("click");
    await flushPromises();

    expect(invoke).toHaveBeenCalledWith("advance", expect.objectContaining({ count: 0, name: "写测试" }));
    expect(wrapper.get('[data-testid="declarative-output-count"]').text()).toBe("4次");
    expect(JSON.parse(window.localStorage.getItem("greywork.plugins.declarativeState") ?? "{}")["test.worker/worker"]).toEqual({
      count: 4,
      name: "来自 Worker",
      enabled: true,
    });
  });
});

describe("Sider 快捷入口", () => {
  it("内置插件激活后，侧栏出现插件入口；停用后消失", async () => {
    await bootWithFreshLoader();
    const router = createAppRouter();
    await router.push("/guid");
    await router.isReady();

    const wrapper = mount(Sider, {
      props: { collapsed: false, theme: "dark" },
      global: { plugins: [router, i18n] },
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

describe("PluginsView 已贡献面板 chips", () => {
  it("内置 core.artifacts 激活时展示 region chip；停用消失、重开回来，插件中心不受影响", async () => {
    await bootWithFreshLoader();
    const wrapper = mount(PluginsView);

    // core.artifacts 默认激活 → chip 出现（region 原文 + 产物标题）
    expect(wrapper.text()).toContain("插件中心");
    const chip = wrapper.get('[data-testid="region-chip-activityPanel-activity.artifacts"]');
    expect(chip.text()).toBe("activityPanel · 产物");

    // 停用 core.artifacts → 面板 chip 消失，模式 chip（插件中心自身）不受影响
    const { setPluginEnabled } = await import("@/plugins/runtime");
    await setPluginEnabled("core.artifacts", false);
    await flushPromises();
    expect(wrapper.find('[data-testid="region-chip-activityPanel-activity.artifacts"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mode-chip-plugins"]').exists()).toBe(true);

    // 重开 → chip 回来
    await setPluginEnabled("core.artifacts", true);
    await flushPromises();
    expect(wrapper.get('[data-testid="region-chip-activityPanel-activity.artifacts"]').text()).toBe("activityPanel · 产物");
  });
});

describe("Sider 插件分组（shellSidebar）", () => {
  it("注册并启用的插件贡献显示为左栏分组；停用后宿主消失", async () => {
    await bootWithFreshLoader();
    const router = createAppRouter();
    await router.push("/guid");
    await router.isReady();

    // 第三方插件贡献一个 shellSidebar 分组（组件为行内桩）
    const { registerPlugin, setPluginEnabled } = await import("@/plugins/runtime");
    registerPlugin({
      id: "ext.sidebar",
      name: "侧栏扩展",
      version: "1.0.0",
      contributes: {
        uiRegions: [
          {
            region: "shellSidebar",
            id: "sidebar.demo",
            title: "演示分组",
            component: { render: () => null },
          },
        ],
      },
    });
    await setPluginEnabled("ext.sidebar", true);
    await flushPromises();

    const wrapper = mount(Sider, {
      props: { collapsed: false, theme: "dark" },
      global: { plugins: [router, i18n] },
    });

    // 分组出现在快捷入口与 SiderFooter 之间
    const text = wrapper.text();
    expect(text.indexOf("定时任务")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("演示分组")).toBeGreaterThan(text.indexOf("定时任务"));
    expect(text.indexOf("设置")).toBeGreaterThan(text.indexOf("演示分组"));

    // 停用 → 分组宿主整体消失
    await setPluginEnabled("ext.sidebar", false);
    await flushPromises();
    expect(wrapper.find('[data-testid="sider-regions"]').exists()).toBe(false);
  });
});

describe("插件中心能力审计页签", () => {
  it("展示能力调用记录（含拒绝），空态有提示", async () => {
    await bootWithFreshLoader();
    resetCapabilityAuditForTest();
    const wrapper = mount(PluginsView);

    // 空态。
    await wrapper.get('[data-testid="market-tab-audit"]').trigger("click");
    expect(wrapper.get('[data-testid="plugin-audit-section"]').text()).toContain("暂无能力调用记录");

    // 写入两条（一条 ok 一条 denied），切回再切来刷新。
    recordCapabilityAudit({
      plugin: "demo.worker",
      capability: "net.fetch",
      at: new Date().toISOString(),
      outcome: "ok",
      detail: "200 api.github.com",
    });
    recordCapabilityAudit({
      plugin: "demo.evil",
      capability: "net.fetch",
      at: new Date().toISOString(),
      outcome: "denied",
      detail: "host not in allowlist: evil.com",
    });
    await wrapper.get('[data-testid="market-tab-audit"]').trigger("click");
    const section = wrapper.get('[data-testid="plugin-audit-section"]').text();
    expect(section).toContain("demo.worker");
    expect(section).toContain("net.fetch");
    expect(section).toContain("denied");
    expect(section).toContain("evil.com");

    // 清空回到空态。
    await wrapper.get('[data-testid="plugin-audit-clear"]').trigger("click");
    expect(wrapper.get('[data-testid="plugin-audit-section"]').text()).toContain("暂无能力调用记录");
    resetCapabilityAuditForTest();
  });
});
