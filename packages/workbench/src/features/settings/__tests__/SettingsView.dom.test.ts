// 设置面板契约：分区由 `section` prop 决定（设置本身是 SettingsDialog 弹窗，不再是路由页）；
// 外观区可切语言（写回 settings.locale）。
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SettingsView from "@/features/settings/SettingsView.vue";
import { createAppRouter } from "@/router";
import { i18n, setLocale } from "@/i18n";
import { useSettingsStore } from "@/stores/settings";
import { useAgentStore } from "@/stores/agent";

async function mountSettings(section: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createAppRouter();
  await router.push("/guid");
  await router.isReady();
  const wrapper = mount(SettingsView, { props: { section }, global: { plugins: [pinia, i18n, router] } });
  return { pinia, router, wrapper };
}

beforeEach(() => {
  window.localStorage.clear();
  // i18n 是全局单例，上一个用例切到 en-US 会漏给下一个；断言中文文案的用例会因此翻车。
  setLocale("zh-CN");
});

describe("SettingsView", () => {
  it("agent 分区渲染默认模型供应商区", async () => {
    const { wrapper } = await mountSettings("agent");
    expect(wrapper.text()).toContain("Agent");
    expect(wrapper.text()).toContain("默认模型供应商");
  });

  it("appearance 分区可独立切换主题、深色模式和字号并持久化", async () => {
    const { wrapper } = await mountSettings("appearance");
    const settings = useSettingsStore();
    expect(wrapper.text()).toContain("主题配色");
    expect(wrapper.text()).toContain("深色模式");
    expect(wrapper.text()).toContain("界面字号");

    await wrapper.get('[data-testid="theme-github"]').trigger("click");
    await wrapper.get('[data-testid="color-mode-light"]').trigger("click");
    await wrapper.get('[data-testid="font-size-large"]').trigger("click");

    expect(settings.theme).toBe("github");
    expect(settings.colorMode).toBe("light");
    expect(settings.fontSize).toBe("large");
    expect(document.documentElement.dataset.theme).toBe("light");

    await wrapper.get('[data-testid="color-mode-dark"]').trigger("click");
    expect(settings.colorMode).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    const reloaded = useSettingsStore();
    expect(reloaded.theme).toBe("github");
    expect(reloaded.colorMode).toBe("dark");
    expect(reloaded.fontSize).toBe("large");
  });

  it("appearance 分区可切换界面语言", async () => {
    const { wrapper } = await mountSettings("appearance");
    const settings = useSettingsStore();
    const english = wrapper.findAll("button").find((button) => button.text().trim() === "English");
    expect(english).toBeDefined();
    await english!.trigger("click");
    expect(settings.locale).toBe("en-US");
  });

  it("未知分区落在 meta 兜底（头部显示 agent 元信息）", async () => {
    const { wrapper } = await mountSettings("no-such-section");
    expect(wrapper.text()).toContain("Agent");
    expect(wrapper.text()).toContain("模型供应商与默认后端");
  });

  it("agent 分区可新增自配 ACP 后端：填名称与命令后出现在列表", async () => {
    const { wrapper } = await mountSettings("agent");
    const addButton = wrapper.findAll("button").find((button) => button.text().trim() === "新增后端");
    expect(addButton).toBeDefined();
    await addButton!.trigger("click");
    expect(wrapper.text()).toContain("新增 ACP 后端");

    const inputs = wrapper.findAll("input");
    const nameInput = inputs.find((input) => input.attributes("placeholder") === "如 My Agent");
    const commandInput = inputs.find((input) => input.attributes("placeholder")?.startsWith("如 my-agent"));
    expect(nameInput).toBeDefined();
    expect(commandInput).toBeDefined();
    await nameInput!.setValue("My Agent");
    await commandInput!.setValue("my-agent acp");

    const saveButton = wrapper.findAll("button").find((button) => button.text().trim() === "保存");
    expect(saveButton).toBeDefined();
    await saveButton!.trigger("click");

    expect(wrapper.text()).toContain("My Agent");
    expect(wrapper.text()).toContain("my-agent acp");
  });
});

describe("SettingsView team 分区", () => {
  it("渲染并发度滑块；拖动后写回 settings.maxParallel 并持久化", async () => {
    const { wrapper } = await mountSettings("team");
    const settings = useSettingsStore();
    expect(wrapper.text()).toContain("编排并发度");

    const slider = wrapper.find('[data-testid="max-parallel"]');
    expect(slider.exists()).toBe(true);
    expect(slider.attributes("min")).toBe("1");
    expect(slider.attributes("max")).toBe("8");
    expect((slider.element as HTMLInputElement).value).toBe("2");

    await slider.setValue("4");
    expect(settings.maxParallel).toBe(4);
    expect(wrapper.find('[data-testid="max-parallel-value"]').text()).toBe("4");
    // 已持久化（写 store + persist 路径）
    setActivePinia(createPinia());
    expect(useSettingsStore().maxParallel).toBe(4);
  });
});

describe("SettingsView ACP 图标", () => {
  it("点行首图标换图标：选择器和预设后端都可用，选中即写回 store", async () => {
    const { wrapper } = await mountSettings("agent");
    const agent = useAgentStore();
    const preset = agent.agentProviders[0]!;
    expect(preset.icon).toBeUndefined();

    expect(wrapper.find('[data-testid="agent-icon-picker"]').exists()).toBe(false);
    await wrapper.get(`[data-testid="agent-icon-${preset.id}"]`).trigger("click");
    await wrapper.get('[data-testid="icon-option-lightning"]').trigger("click");

    expect(agent.agentProviders.find((provider) => provider.id === preset.id)?.icon).toBe("lightning");
  });

  it("新增自配后端时可顺手选图标，保存后带上它", async () => {
    const { wrapper } = await mountSettings("agent");
    const addButton = wrapper.findAll("button").find((button) => button.text().trim() === "新增后端");
    await addButton!.trigger("click");

    const inputs = wrapper.findAll("input");
    await inputs.find((input) => input.attributes("placeholder") === "如 My Agent")!.setValue("My Agent");
    await inputs.find((input) => input.attributes("placeholder")?.startsWith("如 my-agent"))!.setValue("my-agent acp");
    await wrapper.get('[data-testid="icon-option-magic"]').trigger("click");

    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "保存")!
      .trigger("click");

    const agent = useAgentStore();
    expect(agent.agentProviders.find((provider) => provider.name === "My Agent")?.icon).toBe("magic");
  });
});

describe("SettingsView 远程助手分区", () => {
  it("通道配置与助手默认行为同区：微信面板 + 原有开关，浏览器态如实说明不可用", async () => {
    const { wrapper } = await mountSettings("assistant");
    expect(wrapper.get("h1").text()).toBe("远程助手");
    expect(wrapper.find('[data-testid="remote-channels-pane"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("Plan 模式");
    expect(wrapper.text()).toContain("速度加成");
    // 浏览器态没有宿主：给出原因，而不是渲染点了没反应的按钮
    expect(wrapper.text()).toContain("通道仅桌面端可用。");
  });
});
