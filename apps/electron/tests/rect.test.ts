import { describe, expect, it } from "vitest";

import { sanitizeRect } from "../src/shared/rect";

describe("sanitizeRect", () => {
  it("合法矩形取整后原样采用", () => {
    expect(sanitizeRect({ x: 10.4, y: 0, width: 480, height: 300.6 })).toEqual({
      x: 10,
      y: 0,
      width: 480,
      height: 301,
    });
  });

  it("缺字段 / 非数字一律落 0", () => {
    expect(sanitizeRect({})).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(sanitizeRect({ x: "10", y: NaN, width: Infinity, height: null })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it("负宽高夹到 0（setBounds 不接受负值）", () => {
    expect(sanitizeRect({ x: -5, y: -5, width: -100, height: -1 })).toEqual({
      x: -5,
      y: -5,
      width: 0,
      height: 0,
    });
  });

  it("非对象返回 null（调用方据此跳过这次定位）", () => {
    expect(sanitizeRect(null)).toBeNull();
    expect(sanitizeRect(undefined)).toBeNull();
    expect(sanitizeRect("x")).toBeNull();
    expect(sanitizeRect(42)).toBeNull();
  });
});
