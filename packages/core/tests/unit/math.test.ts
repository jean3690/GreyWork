import { describe, expect, it } from "vitest";
import { add, clamp, formatNumber, lerp, normalize, scale } from "../../src/math";
import type { Vector3 } from "../../src/types";

describe("clamp", () => {
  it("低于下界时收敛到 min", () => {
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(-0.0001, 0, 1)).toBe(0);
  });

  it("高于上界时收敛到 max", () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });

  it("边界值本身保持不变（含 0）", () => {
    expect(clamp(0, 0, 100)).toBe(0);
    expect(clamp(100, 0, 100)).toBe(100);
  });

  it("区间内的值原样返回", () => {
    expect(clamp(42, 0, 100)).toBe(42);
    expect(clamp(-3, -10, 10)).toBe(-3);
  });

  it("大数不丢失精度", () => {
    const big = Number.MAX_SAFE_INTEGER;
    expect(clamp(big, 0, big)).toBe(big);
    expect(clamp(big + 1, 0, big)).toBe(big);
  });

  it("min > max 时返回 max（实现定义的退化行为）", () => {
    // Math.min(max, Math.max(min, v))：max 先生效，min > max 时结果恒为 max
    expect(clamp(5, 10, 2)).toBe(2);
  });
});

describe("lerp", () => {
  it("t=0 返回 a，t=1 返回 b", () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
  });

  it("中点插值", () => {
    expect(lerp(10, 20, 0.5)).toBe(15);
  });

  it("负数区间可插值", () => {
    expect(lerp(-10, -20, 0.5)).toBe(-15);
  });

  it("t 超出 [0,1] 时外推", () => {
    expect(lerp(10, 20, -0.5)).toBe(5);
    expect(lerp(10, 20, 1.5)).toBe(25);
  });

  it("a === b 时任意 t 都返回该值", () => {
    expect(lerp(7, 7, 0.37)).toBe(7);
  });

  it("大数量级下 a 与 (b-a)*t 相加仍精确", () => {
    // 当 |b-a| << |a| 时浮点加法会吞掉增量，这是实现的固有精度边界
    const base = 1e16;
    expect(lerp(base, base + 1, 0.5)).toBe(base);
  });
});

describe("normalize", () => {
  it("单位向量归一化后不变", () => {
    expect(normalize({ x: 1, y: 0, z: 0 })).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("一般向量归一化后长度为 1", () => {
    const v = normalize({ x: 3, y: 4, z: 0 });
    expect(v.x).toBeCloseTo(0.6);
    expect(v.y).toBeCloseTo(0.8);
    expect(v.z).toBeCloseTo(0);
    const len = Math.hypot(v.x, v.y, v.z);
    expect(len).toBeCloseTo(1);
  });

  it("零向量退化为零向量（length || 1 防除零）", () => {
    expect(normalize({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("负分量保留方向符号", () => {
    const v = normalize({ x: -3, y: 4, z: 0 });
    expect(v.x).toBeCloseTo(-0.6);
    expect(v.y).toBeCloseTo(0.8);
  });

  it("大数量级向量归一化仍得到单位长度", () => {
    const v = normalize({ x: 1e8, y: 0, z: 0 });
    expect(v.x).toBe(1);
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1);
  });

  it("不修改入参", () => {
    const input: Vector3 = { x: 3, y: 4, z: 0 };
    normalize(input);
    expect(input).toEqual({ x: 3, y: 4, z: 0 });
  });
});

describe("add", () => {
  it("逐分量相加", () => {
    expect(add({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 })).toEqual({
      x: 5,
      y: 7,
      z: 9,
    });
  });

  it("与零向量相加等于自身", () => {
    const v: Vector3 = { x: 1.5, y: -2, z: 0 };
    expect(add(v, { x: 0, y: 0, z: 0 })).toEqual(v);
  });

  it("相反向量相加得零向量", () => {
    expect(add({ x: 3, y: -3, z: 3 }, { x: -3, y: 3, z: -3 })).toEqual({
      x: 0,
      y: 0,
      z: 0,
    });
  });

  it("大数相加不超过安全整数时不丢精度", () => {
    const big = Number.MAX_SAFE_INTEGER;
    expect(add({ x: big, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toEqual({
      x: big,
      y: 1,
      z: 0,
    });
  });
});

describe("scale", () => {
  it("逐分量缩放", () => {
    expect(scale({ x: 1, y: -2, z: 3 }, 2)).toEqual({ x: 2, y: -4, z: 6 });
  });

  it("缩放系数为 0 得零向量", () => {
    expect(scale({ x: 9, y: 9, z: 9 }, 0)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("负系数反转方向", () => {
    expect(scale({ x: 1, y: 2, z: 3 }, -1)).toEqual({ x: -1, y: -2, z: -3 });
  });

  it("大数与极小系数组合按 IEEE754 规则计算", () => {
    expect(scale({ x: 1e300, y: 0, z: 0 }, 1e-150).x).toBeCloseTo(1e150);
  });
});

describe("formatNumber", () => {
  it("默认保留两位小数", () => {
    expect(formatNumber(3.14159)).toBe("3.14");
  });

  it("显式 precision 生效（含 0 位）", () => {
    expect(formatNumber(3.14159, 0)).toBe("3");
    expect(formatNumber(3.14159, 4)).toBe("3.1416");
  });

  it("四舍五入而非截断（受二进制表示影响）", () => {
    expect(formatNumber(2.675, 2)).toBe("2.67"); // 2.675 的二进制表示略小于真值
    expect(formatNumber(1.005, 2)).toBe("1.00");
    expect(formatNumber(0.125, 2)).toBe("0.13"); // 0.125 可被精确表示
  });

  it("负数与零", () => {
    expect(formatNumber(-3.14159)).toBe("-3.14");
    expect(formatNumber(0)).toBe("0.00");
  });

  it("大数按 precision 补齐小数位", () => {
    expect(formatNumber(123456789, 1)).toBe("123456789.0");
  });
});
