// 设置页契约：分区由路由 :section 决定；外观区可切语言（写回 settings.locale）。
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SettingsView from "@/views/SettingsView.vue";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";
import { useSettingsStore } from "@/stores/settings";

async function mountSettings(section: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createAppRouter();
  await router.push(`/settings/${section}`);
  await router.isReady();
  const wrapper = mount(SettingsView, { global: { plugins: [pinia, i18n, router] } });
  return { pinia, router, wrapper };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("SettingsView", () => {
  it("agent 分区渲染默认模型供应商区", async () => {
    const { wrapper } = await mountSettings("agent");
    expect(wrapper.text()).toContain("Agent");
    expect(wrapper.text()).toContain("默认模型供应商");
  });

  it("appearance 分区渲染主题与语言；点 English 切走 settings.locale", async () => {
    const { wrapper } = await mountSettings("appearance");
    const settings = useSettingsStore();
    expect(wrapper.text()).toContain("外观");
    expect(wrapper.text()).toContain("语言");

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
