import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SiderToolbar from "@/components/SiderToolbar.vue";

describe("SiderToolbar", () => {
  it("展开时只显示品牌与 logo，点击品牌请求收起", async () => {
    const wrapper = mount(SiderToolbar, { props: { collapsed: false } });

    expect(wrapper.text()).toContain("GreyWork");
    expect(wrapper.text()).not.toContain("新对话");
    expect(wrapper.get('[data-testid="sider-brand-toggle"]').attributes("aria-label")).toBe("收起侧栏");

    await wrapper.get('[data-testid="sider-brand-toggle"]').trigger("click");
    expect(wrapper.emitted("toggleSider")).toHaveLength(1);
  });

  it("折叠时只保留 logo，点击请求展开", async () => {
    const wrapper = mount(SiderToolbar, { props: { collapsed: true } });

    expect(wrapper.text()).not.toContain("GreyWork");
    expect(wrapper.get('[data-testid="sider-brand-toggle"]').attributes("aria-label")).toBe("展开侧栏");
    expect(wrapper.find("img").exists()).toBe(true);

    await wrapper.get('[data-testid="sider-brand-toggle"]').trigger("click");
    expect(wrapper.emitted("toggleSider")).toHaveLength(1);
  });
});
