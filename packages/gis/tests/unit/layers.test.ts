import { describe, expect, it } from "vitest";
import { DEFAULT_LAYERS, SAMPLE_FEATURES, layerKindLabel, visibleFeatures } from "../../src/layers";

describe("visibleFeatures", () => {
  it("只返回可见图层上的要素", () => {
    // 影像层默认不可见：SAMPLE_FEATURES 里没有 imagery 要素，先关掉矢量验证过滤生效
    const layers = DEFAULT_LAYERS.map((l) => (l.id === "vector" ? { ...l, visible: false } : l));
    const result = visibleFeatures(layers, SAMPLE_FEATURES);
    const ids = result.map((f) => f.id);
    expect(ids).toContain("beijing");
    expect(ids).not.toContain("shanghai");
    expect(ids).not.toContain("shenzhen");
    expect(ids).not.toContain("berlin");
  });

  it("全部图层隐藏时返回空数组", () => {
    const hidden = DEFAULT_LAYERS.map((l) => ({ ...l, visible: false }));
    expect(visibleFeatures(hidden, SAMPLE_FEATURES)).toEqual([]);
  });

  it("要素归属的图层关闭后即被排除，与其它图层无关", () => {
    // 悉尼在 terrain 层，只关 terrain
    const layers = DEFAULT_LAYERS.map((l) => (l.id === "terrain" ? { ...l, visible: false } : l));
    const ids = visibleFeatures(layers, SAMPLE_FEATURES).map((f) => f.id);
    expect(ids).not.toContain("sydney");
    expect(ids).not.toContain("cairo");
    expect(ids).toContain("newyork"); // live 层不受影响
  });

  it("未知图层的要素不会凭空出现", () => {
    const features = [...SAMPLE_FEATURES, { id: "ghost", label: "?", coordinate: { lon: 0, lat: 0 }, layer: "no-such-layer" }];
    expect(visibleFeatures(DEFAULT_LAYERS, features).map((f) => f.id)).not.toContain("ghost");
  });
});

describe("layerKindLabel", () => {
  it("四种图层类型各有中文标签", () => {
    expect(layerKindLabel("terrain")).toBe("地形");
    expect(layerKindLabel("imagery")).toBe("影像");
    expect(layerKindLabel("vector")).toBe("矢量");
    expect(layerKindLabel("live")).toBe("实时");
  });
});

describe("DEFAULT_LAYERS", () => {
  it("id 唯一且 kind 合法", () => {
    const ids = DEFAULT_LAYERS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const layer of DEFAULT_LAYERS) {
      expect(["terrain", "imagery", "vector", "live"]).toContain(layer.kind);
    }
  });

  it("SAMPLE_FEATURES 的 layer 都指向真实图层", () => {
    const ids = new Set(DEFAULT_LAYERS.map((l) => l.id));
    for (const f of SAMPLE_FEATURES) expect(ids.has(f.layer)).toBe(true);
  });
});
