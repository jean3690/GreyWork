/**
 * 视口测量包装：0×0 读数必须被丢弃。
 *
 * 这条守卫的由来：virtual-core 在滚动元素挂上时**同步**读一次视口尺寸（3.19 起读
 * clientWidth/clientHeight，更早读 offsetWidth/offsetHeight），元素还没布局时读到 0×0，
 * 而 0 会覆盖 initialRect —— 可视行算成空集，整列渲染不出来。
 */
import { describe, expect, it, vi } from "vitest";
import type { Virtualizer } from "@tanstack/vue-virtual";
import { observeNonZeroRect } from "@/lib/virtual-rect";

/** 构造一个只满足 observeElementRect 所需字段的假实例（尺寸由 client* / offset* 决定）。 */
function instanceWith(size: { width: number; height: number }): Virtualizer<HTMLElement, Element> {
  const element = document.createElement("div");
  // 两套尺寸都给：virtual-core 3.19 起量 client*，更早量 offset*，只填一套会在升级后读到 0×0。
  for (const [key, value] of [
    ["clientWidth", size.width],
    ["clientHeight", size.height],
    ["offsetWidth", size.width],
    ["offsetHeight", size.height],
  ] as const) {
    Object.defineProperty(element, key, { value, configurable: true });
  }
  document.body.appendChild(element);
  return { scrollElement: element, targetWindow: window } as unknown as Virtualizer<HTMLElement, Element>;
}

describe("observeNonZeroRect", () => {
  it("0×0 读数被丢弃（保留 initialRect 的机会）", () => {
    const cb = vi.fn();
    observeNonZeroRect(instanceWith({ width: 0, height: 0 }), cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("非 0 读数照常上报", () => {
    const cb = vi.fn();
    observeNonZeroRect(instanceWith({ width: 300, height: 600 }), cb);
    expect(cb).toHaveBeenCalledWith({ width: 300, height: 600 });
  });
});
