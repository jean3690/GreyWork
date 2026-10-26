/**
 * GeoJSON 归一化与包围盒：GIS 预览的纯逻辑层。
 *
 * 归一化的意义是「一种形状进渲染层」—— 要素数、图层分类、视野都按 features 算，
 * 不在渲染层到处判 type；非法数据必须在归一化时就被挡下（否则是一张空图，最难查）。
 */
import { describe, expect, it } from "vitest";
import {
  boundsOfCollection,
  countByShape,
  isOutsideLonLat,
  parseGeoJsonText,
  pointOfGeometry,
  shapeOfGeometry,
  shapesOfCollection,
  toFeatureCollection,
  unrenderableCount,
} from "@/lib/geojson";

const POINT = { type: "Point", coordinates: [116.39, 39.9] };

describe("toFeatureCollection", () => {
  it("FeatureCollection 原样归一（属性缺省补 null）", () => {
    const collection = toFeatureCollection({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: POINT, properties: { name: "北京" } },
        { type: "Feature", geometry: POINT },
      ],
    });
    expect(collection?.features).toHaveLength(2);
    expect(collection?.features[0].properties).toEqual({ name: "北京" });
    expect(collection?.features[1].properties).toBeNull();
  });

  it("单个 Feature 与裸几何都补成 FeatureCollection", () => {
    expect(toFeatureCollection({ type: "Feature", geometry: POINT, properties: {} })?.features).toHaveLength(1);
    expect(toFeatureCollection(POINT)?.features[0].geometry).toEqual(POINT);
    expect(toFeatureCollection(POINT)?.features[0].properties).toBeNull();
  });

  it("非法输入返回 null，不抛异常（由调用方给人话错误）", () => {
    expect(toFeatureCollection(null)).toBeNull();
    expect(toFeatureCollection("nope")).toBeNull();
    expect(toFeatureCollection({})).toBeNull();
    expect(toFeatureCollection({ type: "Nonsense" })).toBeNull();
    // features 里有非 Feature 成员：整体判非法，而不是悄悄丢掉那一条
    expect(toFeatureCollection({ type: "FeatureCollection", features: [{ type: "Point", coordinates: [0, 0] }] })).toBeNull();
    expect(toFeatureCollection({ type: "FeatureCollection", features: "x" })).toBeNull();
  });
});

describe("parseGeoJsonText", () => {
  it("解析合法 GeoJSON", () => {
    const collection = parseGeoJsonText(JSON.stringify({ type: "FeatureCollection", features: [] }));
    expect(collection.type).toBe("FeatureCollection");
  });

  it("非法 JSON 与非法 GeoJSON 给的是两类可区分的错误", () => {
    expect(() => parseGeoJsonText("{oops")).toThrow(/不是合法 JSON/);
    expect(() => parseGeoJsonText('{"type":"Nope"}')).toThrow(/不是合法的 GeoJSON/);
  });
});

describe("shapeOfGeometry", () => {
  it("按几何类型分类（Multi* 与基础类型同类）", () => {
    expect(shapeOfGeometry({ type: "Point" })).toBe("point");
    expect(shapeOfGeometry({ type: "MultiPoint" })).toBe("point");
    expect(shapeOfGeometry({ type: "LineString" })).toBe("line");
    expect(shapeOfGeometry({ type: "MultiLineString" })).toBe("line");
    expect(shapeOfGeometry({ type: "Polygon" })).toBe("polygon");
    expect(shapeOfGeometry({ type: "MultiPolygon" })).toBe("polygon");
  });

  it("GeometryCollection 取第一个可识别的子几何", () => {
    expect(shapeOfGeometry({ type: "GeometryCollection", geometries: [{ type: "Nope" }, { type: "Polygon" }] })).toBe("polygon");
    expect(shapeOfGeometry({ type: "GeometryCollection", geometries: [] })).toBeNull();
  });

  it("非几何输入返回 null", () => {
    expect(shapeOfGeometry(null)).toBeNull();
    expect(shapeOfGeometry({ type: "Feature" })).toBeNull();
  });
});

describe("shapesOfCollection", () => {
  it("去重且按「点 → 线 → 面」固定顺序（图层叠放顺序要稳定）", () => {
    const collection = toFeatureCollection({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Polygon", coordinates: [] } },
        { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] } },
        { type: "Feature", geometry: { type: "Point", coordinates: [1, 1] } },
        { type: "Feature", geometry: { type: "LineString", coordinates: [] } },
      ],
    })!;
    expect(shapesOfCollection(collection)).toEqual(["point", "line", "polygon"]);
  });
});

describe("boundsOfCollection", () => {
  it("算出 [west, south, east, north]", () => {
    const collection = toFeatureCollection({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [116, 39] } },
        { type: "Feature", geometry: { type: "Point", coordinates: [118, 41] } },
      ],
    })!;
    expect(boundsOfCollection(collection)).toEqual([116, 39, 118, 41]);
  });

  it("嵌套坐标（Polygon / GeometryCollection）也要算进去", () => {
    const polygon = toFeatureCollection({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
      ],
    })!;
    expect(boundsOfCollection(polygon)).toEqual([0, 0, 2, 2]);

    const mixed = toFeatureCollection({
      type: "GeometryCollection",
      geometries: [{ type: "Point", coordinates: [-5, -3] }],
    })!;
    expect(boundsOfCollection(mixed)).toEqual([-5, -3, -5, -3]);
  });

  it("没有任何坐标时返回 null（调用方据此跳过 fitBounds）", () => {
    const empty = toFeatureCollection({ type: "FeatureCollection", features: [] })!;
    expect(boundsOfCollection(empty)).toBeNull();
  });
});

describe("countByShape / unrenderableCount", () => {
  const collection = toFeatureCollection({
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] } },
      { type: "Feature", geometry: { type: "MultiPoint", coordinates: [[0, 0]] } },
      { type: "Feature", geometry: { type: "Polygon", coordinates: [] } },
      // 画不出来的：geometry 为 null、类型不认识
      { type: "Feature", geometry: null },
      { type: "Feature", geometry: { type: "Nope" } },
    ],
  })!;

  it("按类别计数（没出现的类别给 0 而不是缺键）", () => {
    expect(countByShape(collection)).toEqual({ point: 2, line: 0, polygon: 1 });
  });

  it("画不出来的要素单独数出来（预览会静默跳过它们）", () => {
    expect(unrenderableCount(collection)).toBe(2);
    expect(unrenderableCount(toFeatureCollection({ type: "FeatureCollection", features: [] })!)).toBe(0);
  });
});

describe("isOutsideLonLat", () => {
  it("经纬度范围内的包围盒不判为投影坐标", () => {
    expect(isOutsideLonLat([116, 39, 118, 41])).toBe(false);
    expect(isOutsideLonLat([-180, -90, 180, 90])).toBe(false);
  });

  it("超出 ±180 / ±90 的（UTM 米制）判为投影坐标", () => {
    expect(isOutsideLonLat([499000, 4649000, 500000, 4650000])).toBe(true);
    expect(isOutsideLonLat([-200, 0, -190, 10])).toBe(true);
    expect(isOutsideLonLat([0, -95, 10, 0])).toBe(true);
  });
});

describe("pointOfGeometry", () => {
  it("单点几何返回 [lon, lat]", () => {
    expect(pointOfGeometry({ type: "Point", coordinates: [116.39, 39.9] })).toEqual([116.39, 39.9]);
  });

  it("非 Point / 坐标不合法返回 null", () => {
    expect(pointOfGeometry({ type: "MultiPoint", coordinates: [[116, 39]] })).toBeNull();
    expect(pointOfGeometry({ type: "Point", coordinates: ["x"] })).toBeNull();
    expect(pointOfGeometry(null)).toBeNull();
  });
});
