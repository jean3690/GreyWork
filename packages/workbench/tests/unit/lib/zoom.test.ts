/**
 * 缩放手感的数学部分：滚轮一格该放多大、触控板捏合该多灵敏、
 * 异常 delta 要不要兜住、横向手势该不该平移。
 */
import { describe, expect, it } from "vitest";
import { isHorizontalWheel, wheelDeltaX, wheelDeltaY, wheelZoomFactor } from "@/lib/zoom";

describe("wheelDelta", () => {
  it("像素模式原样返回", () => {
    expect(wheelDeltaY({ deltaY: 120, deltaMode: 0 })).toBe(120);
    expect(wheelDeltaX({ deltaX: -8, deltaMode: 0 })).toBe(-8);
  });

  it("行 / 页模式折算成像素", () => {
    expect(wheelDeltaY({ deltaY: 3, deltaMode: 1 })).toBe(48);
    expect(wheelDeltaY({ deltaY: 2, deltaMode: 2 })).toBe(800);
  });
});

describe("wheelZoomFactor", () => {
  it("鼠标一格（100px）约 1.22 倍，反向约 0.82 倍", () => {
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false })).toBeCloseTo(1.2214, 3);
    expect(wheelZoomFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false })).toBeCloseTo(0.8187, 3);
  });

  it("累计位移相同则倍率相同：两次 50px 等于一次 100px", () => {
    const once = wheelZoomFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false });
    const first = wheelZoomFactor({ deltaY: -50, deltaMode: 0, ctrlKey: false });
    const second = wheelZoomFactor({ deltaY: -50, deltaMode: 0, ctrlKey: false });
    expect(first * second).toBeCloseTo(once, 6);
  });

  it("触控板捏合（ctrl+wheel）的增益明显更大", () => {
    const pinch = wheelZoomFactor({ deltaY: -10, deltaMode: 0, ctrlKey: true });
    const wheel = wheelZoomFactor({ deltaY: -10, deltaMode: 0, ctrlKey: false });
    expect(pinch).toBeGreaterThan(wheel);
    expect(pinch).toBeCloseTo(Math.E ** 0.1, 3);
  });

  it("异常大的 delta 被夹在 0.5×～2×，不会一帧跳到天边", () => {
    expect(wheelZoomFactor({ deltaY: -5000, deltaMode: 0, ctrlKey: false })).toBe(2);
    expect(wheelZoomFactor({ deltaY: 5000, deltaMode: 0, ctrlKey: false })).toBe(0.5);
  });

  it("delta 为 0 时不缩放", () => {
    expect(wheelZoomFactor({ deltaY: 0, deltaMode: 0, ctrlKey: false })).toBe(1);
  });
});

describe("isHorizontalWheel", () => {
  it("横向明显大于纵向才算平移", () => {
    expect(isHorizontalWheel({ deltaX: 30, deltaY: 5, ctrlKey: false })).toBe(true);
    expect(isHorizontalWheel({ deltaX: 30, deltaY: 40, ctrlKey: false })).toBe(false);
  });

  it("捏合带 deltaX 也仍是缩放", () => {
    expect(isHorizontalWheel({ deltaX: 30, deltaY: 2, ctrlKey: true })).toBe(false);
  });
});
