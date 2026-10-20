// 流式正文：增量文本 append 在光标之前，光标恒驻 host 末尾；整体替换时重绘。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import StreamText from "@/features/conversation/StreamText.vue";

function mountStream(content = "") {
  return mount(StreamText, { props: { content } });
}

function textNodes(host: Element): string[] {
  return Array.from(host.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "");
}

describe("StreamText · 流式正文", () => {
  it("初始内容整体绘制，光标是 host 的最后一个子节点", () => {
    const wrapper = mountStream("你好");
    const host = wrapper.get(".msg__stream");
    expect(host.text()).toBe("你好");
    expect(host.element.lastElementChild).toBe(wrapper.get('[data-testid="stream-caret"]').element);
  });

  it("增量到达：文本追加在光标之前，光标仍驻末尾", async () => {
    const wrapper = mountStream("你好");
    await wrapper.setProps({ content: "你好，世界" });
    const host = wrapper.get(".msg__stream");
    expect(host.text()).toBe("你好，世界");
    expect(textNodes(host.element).join("")).toBe("你好，世界");
    expect(host.element.lastElementChild).toBe(wrapper.get('[data-testid="stream-caret"]').element);
  });

  it("内容整体变短（错误回退）：重绘而非在尾部追加", async () => {
    const wrapper = mountStream("很长的中间态");
    await wrapper.setProps({ content: "出错了" });
    const host = wrapper.get(".msg__stream");
    expect(host.text()).toBe("出错了");
    expect(host.element.lastElementChild).toBe(wrapper.get('[data-testid="stream-caret"]').element);
  });
});
