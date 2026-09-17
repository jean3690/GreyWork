import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import PreviewSkeleton from "@/features/preview/PreviewSkeleton.vue";

describe("PreviewSkeleton", () => {
  it("渲染若干条脉冲占位条，且对辅助技术隐藏", () => {
    const wrapper = mount(PreviewSkeleton);
    expect(wrapper.find('[data-testid="preview-skeleton"]').exists()).toBe(true);
    expect(wrapper.findAll("span").length).toBeGreaterThanOrEqual(4);
    expect(wrapper.find('[data-testid="preview-skeleton"]').attributes("aria-hidden")).toBe("true");
  });
});
