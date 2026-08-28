import { describe, expect, it } from "vitest";
import { SAMPLE_FEATURES } from "@greywork/gis";
import { buildCityGeoJson } from "./cesium";

describe("cesium 渲染适配器纯函数", () => {
  it("buildCityGeoJson 输出 FeatureCollection，覆盖全部示例城市", () => {
    const geojson = buildCityGeoJson();
    expect(geojson.type).toBe("FeatureCollection");
    expect(geojson.features).toHaveLength(SAMPLE_FEATURES.length);
  });

  it("每个 Feature 为 Point 几何且 properties 携带 id/name", () => {
    const geojson = buildCityGeoJson();
    for (const feature of geojson.features) {
      expect(feature.type).toBe("Feature");
      expect(feature.geometry.type).toBe("Point");
      expect(typeof feature.properties.id).toBe("string");
      expect(typeof feature.properties.name).toBe("string");
      expect(Array.isArray(feature.geometry.coordinates)).toBe(true);
    }
  });

  it("坐标与 SAMPLE_FEATURES 一一对应", () => {
    const geojson = buildCityGeoJson();
    geojson.features.forEach((feature, index) => {
      expect(feature.geometry.coordinates).toEqual([SAMPLE_FEATURES[index]?.coordinate.lon, SAMPLE_FEATURES[index]?.coordinate.lat]);
    });
  });
});
