/**
 * 宿主侧第三方插件示例组件的可观察行为：demo-counter 视图的局部计数。
 */
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DemoPluginView from "../../../src/plugins/DemoPluginView.vue";

describe("DemoPluginView", () => {
  it("渲染标题与零计数，点按钮自增", async () => {
    const wrapper = mount(DemoPluginView);

    expect(wrapper.get('[data-testid="demo-plugin-view"]').text()).toContain("Demo 插件已运行");
    expect(wrapper.get('[data-testid="demo-plugin-count"]').text()).toBe("0");

    await wrapper.get('[data-testid="demo-plugin-increment"]').trigger("click");
    expect(wrapper.get('[data-testid="demo-plugin-count"]').text()).toBe("1");

    await wrapper.get('[data-testid="demo-plugin-increment"]').trigger("click");
    expect(wrapper.get('[data-testid="demo-plugin-count"]').text()).toBe("2");
  });
});
