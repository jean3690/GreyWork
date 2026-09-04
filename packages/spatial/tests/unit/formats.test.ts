import { describe, expect, it } from "vitest";
import { FORMAT_LABELS, SUPPORTED_FORMATS, createSpatialDescriptor, describeSpatialData, type ParsedSpatialData } from "../../src/formats";

describe("createSpatialDescriptor", () => {
  it("必填三元组 + extras 合并", () => {
    const d = createSpatialDescriptor("kml", "航线", "/data/route.kml", { featureCount: 12 });
    expect(d).toEqual({
      format: "kml",
      name: "航线",
      sourcePath: "/data/route.kml",
      featureCount: 12,
    });
  });

  it("无 extras 时不含可选键", () => {
    const d = createSpatialDescriptor("shp", "地块", "/data/parcels.shp");
    expect(d).not.toHaveProperty("bbox");
    expect(d).not.toHaveProperty("crs");
  });
});

describe("describeSpatialData", () => {
  it("有 bbox 时输出两位小数的范围串", () => {
    const data: ParsedSpatialData = createSpatialDescriptor("geojson", "城市点位", "/data/cities.geojson", {
      bbox: { minLon: 116.3913, minLat: 39.9075, maxLon: 121.4737, maxLat: 31.2304 },
    });
    // 注意 bbox 串是 minLat 在前（lat,lon 顺序），负数与补零也要对
    expect(describeSpatialData(data)).toBe("GeoJSON · 城市点位 · bbox 116.39,39.91 → 121.47,31.23");

    const neg = createSpatialDescriptor("geojson", "x", "/x", {
      bbox: { minLon: -74.006, minLat: -33.8688, maxLon: -0.005, maxLat: 0.004 },
    });
    expect(describeSpatialData(neg)).toBe("GeoJSON · x · bbox -74.01,-33.87 → -0.01,0.00");
  });

  it("无 bbox 时回退到 featureCount，再回退到 tileCount", () => {
    const byFeatures = createSpatialDescriptor("mbtiles", "瓦片库", "/t.mbtiles", { tileCount: 7, featureCount: 99 });
    // featureCount 优先于 tileCount
    expect(describeSpatialData(byFeatures)).toBe("MBTiles · 瓦片库 · 99 records");

    const byTiles = createSpatialDescriptor("mbtiles", "瓦片库", "/t.mbtiles", { tileCount: 7 });
    expect(describeSpatialData(byTiles)).toBe("MBTiles · 瓦片库 · 7 records");
  });

  it("两者皆缺时显示 ?，0 是合法计数不触发回退", () => {
    expect(describeSpatialData(createSpatialDescriptor("shp", "空", "/e.shp"))).toBe("Shapefile · 空 · ?");
    expect(describeSpatialData(createSpatialDescriptor("shp", "零", "/z.shp", { featureCount: 0 }))).toBe("Shapefile · 零 · 0 records");
  });

  it("每种支持格式都有非空标签", () => {
    for (const f of SUPPORTED_FORMATS) {
      expect(FORMAT_LABELS[f].length).toBeGreaterThan(0);
      const d = createSpatialDescriptor(f, "n", "/p");
      expect(describeSpatialData(d).startsWith(FORMAT_LABELS[f] + " · n · ")).toBe(true);
    }
  });
});
