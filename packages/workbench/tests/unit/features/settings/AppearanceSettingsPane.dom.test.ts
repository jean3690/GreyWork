/**
 * 外观面板 · 圆角控件契约（features/settings/AppearanceSettingsPane）：
 *
 * - 三档按 store 的 RADII 渲染，选中项以 aria-pressed 标出；
 * - 点击写回 store，并经 lib/theme 落到 `<html data-radius>`（CSS 靠它调 --gw-radius-scale）。
 *
 * 这里刻意同时断言「store 状态」与「DOM 属性」：只断言 store 的话，applyAppearance 那条链路
 * （store → lib/theme → data-*）断掉也发现不了，而圆角正是靠那个属性生效的。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "@/i18n";
import AppearanceSettingsPane from "@/features/settings/AppearanceSettingsPane.vue";
import { useSettingsStore } from "@/stores/settings";

const mounted: VueWrapper[] = [];
let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  localStorage.clear();
  // 组件与用例必须共用同一个 pinia 实例，否则断言的是另一个 store。
  pinia = createPinia();
  setActivePinia(pinia);
  i18n.global.locale.value = "zh-CN";
});

afterEach(() => {
  while (mounted.length) {
    try {
      mounted.pop()?.unmount();
    } catch {
      // 用例内已显式卸载过：忽略重复卸载。
    }
  }
  document.body.innerHTML = "";
  delete document.documentElement.dataset.radius;
});

function render(): VueWrapper {
  const wrapper = mount(AppearanceSettingsPane, { global: { plugins: [pinia, i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

describe("外观 · 圆角控件", () => {
  it("渲染三档，默认选中「小圆角」", () => {
    const wrapper = render();

    expect(wrapper.find('[data-testid="radius-none"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="radius-small"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="radius-large"]').exists()).toBe(true);

    expect(wrapper.find('[data-testid="radius-small"]').attributes("aria-pressed")).toBe("true");
    expect(wrapper.find('[data-testid="radius-none"]').attributes("aria-pressed")).toBe("false");
  });

  it("点击写回 store 并落到 <html data-radius>", async () => {
    const wrapper = render();
    const settings = useSettingsStore();

    await wrapper.find('[data-testid="radius-none"]').trigger("click");
    expect(settings.radius).toBe("none");
    expect(document.documentElement.dataset.radius).toBe("none");
    expect(wrapper.find('[data-testid="radius-none"]').attributes("aria-pressed")).toBe("true");

    await wrapper.find('[data-testid="radius-large"]').trigger("click");
    expect(settings.radius).toBe("large");
    expect(document.documentElement.dataset.radius).toBe("large");
  });
});
