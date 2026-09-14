/**
 * 布局指示器的契约。
 *
 * 它首先是**指示器**：高亮必须跟随真实的面板可见性（用户用 Ctrl+B 改了布局也要跟上），
 * 其次才是按钮组 —— 点下去必须同时拨两个面板，只拨一个就会出现「指示器说三栏、
 * 实际只剩一个面板」的自相矛盾。这两条都要有用例。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import LayoutModeSwitch from "@/components/LayoutModeSwitch.vue";
import { i18n } from "@/i18n";
import { useLayoutStore } from "@/stores/layout";
import { usePreviewStore } from "@/stores/preview";

function mountSwitch() {
  return mount(LayoutModeSwitch, { global: { plugins: [i18n] } });
}

function buttonOf(wrapper: ReturnType<typeof mount>, mode: string) {
  return wrapper.find(`[data-testid="layout-mode-${mode}"]`);
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  const preview = usePreviewStore();
  preview.setAvailable(true);
  preview.setCollapsed(false);
});

describe("LayoutModeSwitch", () => {
  it("四档齐全，当前模式高亮（aria-pressed）", () => {
    const wrapper = mountSwitch();
    for (const mode of ["split", "chat", "document", "focus"]) {
      const button = buttonOf(wrapper, mode);
      expect(button.exists()).toBe(true);
      expect(button.attributes("aria-pressed")).toBe(mode === "split" ? "true" : "false");
    }
  });

  it("高亮跟随真实面板状态：用 Ctrl+B 的等价操作改了布局，指示器要跟上", async () => {
    const wrapper = mountSwitch();
    const layout = useLayoutStore();
    layout.sidebarCollapsed = true;

    await flushPromises();
    expect(buttonOf(wrapper, "document").attributes("aria-pressed")).toBe("true");
    expect(buttonOf(wrapper, "split").attributes("aria-pressed")).toBe("false");
  });

  it("点击同时拨两个面板（只拨一个就会与指示器自相矛盾）", async () => {
    const wrapper = mountSwitch();
    const layout = useLayoutStore();
    const preview = usePreviewStore();

    await buttonOf(wrapper, "focus").trigger("click");
    expect(layout.sidebarCollapsed).toBe(true);
    expect(preview.collapsed).toBe(true);

    await buttonOf(wrapper, "split").trigger("click");
    expect(layout.sidebarCollapsed).toBe(false);
    expect(preview.collapsed).toBe(false);
  });

  it("槽位图编码面板在场情况：缺位的槽透明，在场的不透明", async () => {
    const wrapper = mountSwitch();
    const preview = usePreviewStore();

    // 三栏：三槽全亮
    preview.setCollapsed(false);
    useLayoutStore().sidebarCollapsed = false;
    await flushPromises();
    expect(buttonOf(wrapper, "split").findAll("span[aria-hidden] span.bg-transparent")).toHaveLength(0);

    // 专注：只剩中槽
    preview.setCollapsed(true);
    useLayoutStore().sidebarCollapsed = true;
    await flushPromises();
    const focusSlots = buttonOf(wrapper, "focus").findAll("span[aria-hidden] span");
    expect(focusSlots.filter((slot) => slot.classes().includes("bg-transparent"))).toHaveLength(2);
    expect(focusSlots.filter((slot) => !slot.classes().includes("bg-transparent"))).toHaveLength(1);
  });

  it("tooltip 带模式名与快捷键序号", () => {
    const wrapper = mountSwitch();

    expect(buttonOf(wrapper, "split").attributes("title")).toContain("Ctrl+1");
    expect(buttonOf(wrapper, "split").attributes("aria-label")).toBeTruthy();
  });
});
