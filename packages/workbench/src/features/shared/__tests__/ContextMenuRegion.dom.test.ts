/**
 * 通用右键区域：命中目标 → 弹菜单；无条目 → 抑制（且拦掉原生菜单）。
 *
 * 这里同时是 reka 行为假设的回归点：
 * - 菜单内容 Portal 到 body（wrapper.find 够不到，断言走 document.body）；
 * - 我们**有**条目时不能 preventDefault，否则 reka 在 nextTick 后判定 defaultPrevented
 *   就整段跳过（菜单不打开）；
 * - 无条目时我们主动 preventDefault。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { h } from "vue";
import ContextMenuRegion from "@/features/shared/ContextMenuRegion.vue";
import { item, separator, type ContextMenuItem, type ContextTarget } from "@/lib/context-menu";

function menuItems(): DOMWrapper<Element>[] {
  return [...document.body.querySelectorAll('[data-testid="context-menu-item"]')].map((el) => new DOMWrapper(el));
}

function menuExists(): boolean {
  return document.body.querySelector('[data-testid="context-menu-content"]') !== null;
}

/** 挂一个最小区域：单个 data-ctx 子元素作为 trigger 的落点。 */
function mountRegion(build: (target: ContextTarget | null) => ContextMenuItem[]) {
  return mount(ContextMenuRegion, {
    props: { build },
    slots: { default: () => h("div", { "data-ctx": "row", "data-path": "/w/a.ts" }, "row") },
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ContextMenuRegion", () => {
  it("命中目标后弹菜单、渲染条目，点选触发回调", async () => {
    const onSelect = vi.fn();
    const seen: (ContextTarget | null)[] = [];
    const wrapper = mountRegion((target) => {
      seen.push(target);
      return [item("打开", onSelect, { icon: "file" }), separator(), item("刷新", vi.fn())];
    });

    await wrapper.get('[data-ctx="row"]').trigger("contextmenu");
    await flushPromises();

    // 命中解析：ctx 与 dataset 都传给了 build。
    expect(seen.at(-1)?.ctx).toBe("row");
    expect(seen.at(-1)?.el.dataset.path).toBe("/w/a.ts");

    expect(menuExists()).toBe(true);
    expect(menuItems().map((entry) => entry.text())).toEqual(["打开", "刷新"]);

    await menuItems()[0].trigger("click");
    await flushPromises();
    expect(onSelect).toHaveBeenCalledOnce();
    // 选中后菜单关闭
    expect(menuExists()).toBe(false);
  });

  it("build 返回空表：不开菜单，并同步拦掉本次右键（原生菜单也不弹）", async () => {
    const wrapper = mountRegion(() => []);
    const el = wrapper.get('[data-ctx="row"]').element;

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    // 我们的抑制是同步的：reka 那条路径要等 nextTick，所以此刻就能断言。
    expect(event.defaultPrevented).toBe(true);

    await flushPromises();
    expect(menuExists()).toBe(false);
  });

  it("未命中任何 data-ctx 的目标：build 收到 null", async () => {
    const seen: (ContextTarget | null)[] = [];
    const wrapper = mount(ContextMenuRegion, {
      props: {
        build: (target: ContextTarget | null) => {
          seen.push(target);
          return [];
        },
      },
      slots: { default: () => h("div", { id: "plain" }, "plain") },
    });

    await wrapper.get("#plain").trigger("contextmenu");
    await flushPromises();
    expect(seen.at(-1)).toBeNull();
    expect(menuExists()).toBe(false);
  });

  it("禁用的条目不触发回调", async () => {
    const onSelect = vi.fn();
    const wrapper = mountRegion(() => [item("禁用项", onSelect, { disabled: true })]);

    await wrapper.get('[data-ctx="row"]').trigger("contextmenu");
    await flushPromises();
    await menuItems()[0].trigger("click");
    await flushPromises();

    expect(onSelect).not.toHaveBeenCalled();
  });
});
