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
});
