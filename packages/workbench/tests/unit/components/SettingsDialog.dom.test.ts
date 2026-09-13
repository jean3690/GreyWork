// 设置弹窗契约：左栏切换分区、右上角关闭与 Esc 退场；内容面板由 SettingsView 按 section 渲染。
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SettingsDialog from "@/components/SettingsDialog.vue";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";

function mountDialog(section: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createAppRouter();
  return mount(SettingsDialog, { props: { open: true, section }, global: { plugins: [pinia, i18n, router] } });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("SettingsDialog", () => {
  it("按 section 渲染对应面板，并在左栏高亮当前分区", () => {
    const wrapper = mountDialog("appearance");
    expect(wrapper.text()).toContain("外观");
    expect(wrapper.get('[data-testid="settings-nav-appearance"]').attributes("aria-current")).toBe("page");
    expect(wrapper.get('[data-testid="settings-nav-agent"]').attributes("aria-current")).toBeUndefined();
  });

  it("点左栏条目只向上报新的分区（开关留在 Shell）", async () => {
    const wrapper = mountDialog("agent");
    await wrapper.get('[data-testid="settings-nav-team"]').trigger("click");
    expect(wrapper.emitted("update:section")).toEqual([["team"]]);
  });

  it("关闭入口与 Esc 都只发关闭诉求，不自作主张改路由", async () => {
    const wrapper = mountDialog("agent");

    await wrapper.get('[data-testid="settings-close"]').trigger("click");
    expect(wrapper.emitted("update:open")).toEqual([[false]]);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(wrapper.emitted("update:open")).toHaveLength(2);
  });

  it("open 为 false 时不渲染", () => {
    setActivePinia(createPinia());
    const wrapper = mount(SettingsDialog, {
      props: { open: false, section: "agent" },
      global: { plugins: [createPinia(), createAppRouter(), i18n] },
    });
    expect(wrapper.find('[data-testid="settings-dialog"]').exists()).toBe(false);
  });
});
