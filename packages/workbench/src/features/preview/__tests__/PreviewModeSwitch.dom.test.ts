/**
 * 模式切换控件：纯展示，只守「当前态可见 + 点击发对值」。
 * 真正的状态归属（写回哪个 tab）由各 viewer 的测试覆盖。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { i18n } from "@/i18n";
import PreviewModeSwitch from "@/features/preview/PreviewModeSwitch.vue";

function mountSwitch(mode: "table" | "analysis") {
  return mount(PreviewModeSwitch, { props: { modelValue: mode }, global: { plugins: [i18n] } });
}

beforeEach(() => {
  i18n.global.locale.value = "zh-CN";
});

describe("PreviewModeSwitch", () => {
  it("两个选项都渲染，并按 modelValue 标出当前态", () => {
    const wrapper = mountSwitch("table");
    expect(wrapper.get('[data-testid="preview-mode-table"]').text()).toBe("表格");
    expect(wrapper.get('[data-testid="preview-mode-analysis"]').text()).toBe("分析");
    expect(wrapper.get('[data-testid="preview-mode-table"]').attributes("aria-pressed")).toBe("true");
    expect(wrapper.get('[data-testid="preview-mode-analysis"]').attributes("aria-pressed")).toBe("false");
  });

  it("点击发出 update:modelValue", async () => {
    const wrapper = mountSwitch("table");
    await wrapper.get('[data-testid="preview-mode-analysis"]').trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([["analysis"]]);
  });
});
