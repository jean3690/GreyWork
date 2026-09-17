import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import PluginRenderCanvas from "@/features/plugins/PluginRenderCanvas.vue";

describe("PluginRenderCanvas", () => {
  it("指令映射为 SVG 元素：circle/rect/text/group 变换", () => {
    const wrapper = mount(PluginRenderCanvas, {
      props: {
        width: 100,
        height: 80,
        commands: [
          { kind: "circle", cx: 50, cy: 40, r: 10, fill: "red" },
          { kind: "rect", x: 0, y: 0, w: 20, h: 10 },
          { kind: "text", x: 5, y: 5, text: "喵" },
          { kind: "group", translate: [1, 2], rotate: 90, children: [{ kind: "ellipse", cx: 0, cy: 0, rx: 3, ry: 2 }] },
        ],
      },
    });
    expect(wrapper.find("svg").attributes("viewBox")).toBe("0 0 100 80");
    expect(wrapper.findAll("circle")).toHaveLength(1);
    expect(wrapper.find("circle").attributes("cx")).toBe("50");
    expect(wrapper.find("circle").attributes("fill")).toBe("red");
    expect(wrapper.findAll("rect")).toHaveLength(1);
    expect(wrapper.find("text").text()).toBe("喵");
    const group = wrapper.find("g");
    expect(group.attributes("transform")).toBe("translate(1 2) rotate(90)");
    expect(group.findAll("ellipse")).toHaveLength(1);
  });
});
