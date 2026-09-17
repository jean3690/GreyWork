/**
 * 预览事件桥：preview:request 全字段透传（source 决定读取通道，开错通道就读不到
 * 文件）、artifact:updated 不抢焦点。PreviewSider 被 stub 掉，桥接挂在真实组件树上。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import PreviewSider from "@/features/preview/PreviewSider.vue";
import { appEvents } from "@/events";
import { usePreviewStore } from "@/stores/preview";

const stubs = { PreviewSurface: { template: "<div data-testid='surface-stub' />" } };

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe("preview-bridge", () => {
  it("preview:request 透传 name/source/diskPath，按 disk 源开 tab", async () => {
    const wrapper = mount(PreviewSider, { global: { stubs } });
    const preview = usePreviewStore();

    appEvents.emit("preview:request", {
      path: "/home/u/out/报告.md",
      name: "报告.md",
      source: "disk",
      diskPath: "/home/u/out/报告.md",
    });
    await wrapper.vm.$nextTick();

    expect(preview.tabs).toHaveLength(1);
    expect(preview.tabs[0]).toMatchObject({ path: "/home/u/out/报告.md", name: "报告.md", source: "disk" });
  });

  it("缺省 source 按 vfs 处理（沿用旧契约的调用方不必改）", async () => {
    const wrapper = mount(PreviewSider, { global: { stubs } });
    const preview = usePreviewStore();

    appEvents.emit("preview:request", { path: "artifacts/a.md" });
    await wrapper.vm.$nextTick();
    expect(preview.tabs[0]?.source).toBe("vfs");
  });

  it("artifact:updated 只重载已打开的 tab，不新开、不改激活项", async () => {
    const wrapper = mount(PreviewSider, { global: { stubs } });
    const preview = usePreviewStore();
    const first = preview.open("a.md");
    const second = preview.open("b.md");
    preview.activate(first);
    await wrapper.vm.$nextTick();

    appEvents.emit("artifact:updated", { name: "b", path: "b.md", source: "chat" });
    await wrapper.vm.$nextTick();
    expect(preview.tabs).toHaveLength(2);
    expect(preview.activeId).toBe(first);
    expect(preview.tabs.find((tab) => tab.id === second)?.revision).toBe(1);

    // 未打开的路径不偷偷弹面板
    appEvents.emit("artifact:updated", { name: "c", path: "c.md", source: "chat" });
    await wrapper.vm.$nextTick();
    expect(preview.tabs).toHaveLength(2);
  });

  it("preview:request 带 diskPath 时补记落盘路径（同路径已开 tab 也能补上）", async () => {
    const wrapper = mount(PreviewSider, { global: { stubs } });
    const preview = usePreviewStore();
    preview.open("artifacts/a.xlsx", "a.xlsx");
    await wrapper.vm.$nextTick();

    appEvents.emit("preview:request", { path: "artifacts/a.xlsx", source: "vfs", diskPath: "/disk/a.xlsx" });
    await wrapper.vm.$nextTick();
    expect(preview.tabs).toHaveLength(1);
    expect(preview.tabs[0]?.diskPath).toBe("/disk/a.xlsx");
  });
});
