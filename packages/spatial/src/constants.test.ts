import { describe, expect, it } from "vitest";
import { DEFAULT_RINGS, describeScene } from "./constants";

describe("describeScene", () => {
  it("grid 开启时输出 grid on", () => {
    const scene = { name: "主场景", nodes: 12, rings: DEFAULT_RINGS, grid: true };
    expect(describeScene(scene)).toBe("主场景 · 12 nodes · 3 orbit rings · grid on");
  });

  it("grid 关闭与空 rings 的边界输出", () => {
    expect(describeScene({ name: "空", nodes: 0, rings: [], grid: false })).toBe("空 · 0 nodes · 0 orbit rings · grid off");
  });
});

describe("DEFAULT_RINGS", () => {
  it("id 唯一、半径严格递增（渲染层级依赖此顺序）", () => {
    const ids = DEFAULT_RINGS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < DEFAULT_RINGS.length; i++) {
      expect(DEFAULT_RINGS[i].radius).toBeGreaterThan(DEFAULT_RINGS[i - 1].radius);
    }
  });

  it("每个环的 count/speed 在合法范围", () => {
    for (const ring of DEFAULT_RINGS) {
      expect(ring.count).toBeGreaterThan(0);
      expect(Math.abs(ring.speed)).toBeLessThanOrEqual(1);
      expect(ring.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
