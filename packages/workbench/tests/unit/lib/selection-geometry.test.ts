/**
 * 浮层定位的纯几何。
 *
 * 放 node project 测是刻意的：happy-dom 没有布局引擎，`getBoundingClientRect()` 恒为全零，
 * 在 DOM 里根本测不出「翻转到下方」「贴边夹住」这些分支。把几何抽成纯函数才测得动。
 */
import { describe, expect, it } from "vitest";
import { placeToolbar } from "@/lib/selection";

const VIEWPORT = { width: 1000, height: 800 };
const SIZE = { width: 200, height: 32 };

describe("placeToolbar", () => {
  it("默认摆在选区上方、水平居中", () => {
    const result = placeToolbar({ left: 400, top: 300, width: 100, height: 20 }, VIEWPORT, SIZE);
    expect(result.left).toBe(450); // 400 + 100/2，组件再 translateX(-50%)
    expect(result.top).toBe(300 - 32 - 8);
    expect(result.flipped).toBe(false);
  });

  it("顶部空间不足时翻到选区下方", () => {
    const result = placeToolbar({ left: 400, top: 10, width: 100, height: 20 }, VIEWPORT, SIZE);
    expect(result.flipped).toBe(true);
    expect(result.top).toBe(10 + 20 + 8);
  });

  it("左边缘处横向夹住，浮层不会有一半在视口外", () => {
    const result = placeToolbar({ left: 0, top: 300, width: 4, height: 20 }, VIEWPORT, SIZE);
    expect(result.left).toBe(8 + 100); // margin + halfWidth
    expect(result.left - SIZE.width / 2).toBeGreaterThanOrEqual(8);
  });

  it("右边缘处横向夹住", () => {
    const result = placeToolbar({ left: 996, top: 300, width: 4, height: 20 }, VIEWPORT, SIZE);
    expect(result.left + SIZE.width / 2).toBeLessThanOrEqual(1000 - 8);
  });

  it("翻到下方后仍然越界时纵向再夹一次（选区本身很高的情况）", () => {
    const result = placeToolbar({ left: 400, top: 5, width: 100, height: 790 }, VIEWPORT, SIZE);
    expect(result.top).toBeLessThanOrEqual(800 - 8 - SIZE.height);
    expect(result.top).toBeGreaterThanOrEqual(8);
  });

  it("视口比浮层还窄时退化为左边距，不产出负数", () => {
    const result = placeToolbar({ left: 10, top: 300, width: 4, height: 20 }, { width: 120, height: 800 }, SIZE);
    expect(result.left).toBeGreaterThanOrEqual(8 + 100);
    expect(Number.isFinite(result.left)).toBe(true);
  });
});
