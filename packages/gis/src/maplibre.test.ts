import { describe, expect, it } from "vitest";
import { SAMPLE_FEATURES } from "./layers";
import { buildCitiesGeoJson } from "./maplibre";

describe("maplibre 渲染适配器纯函数", () => {
  it("buildCitiesGeoJson 输出 FeatureCollection，覆盖全部要素", () => {
    const geojson = buildCitiesGeoJson(SAMPLE_FEATURES);
    expect(geojson.type).toBe("FeatureCollection");
    expect(geojson.features).toHaveLength(SAMPLE_FEATURES.length);
  });

  it("properties.id 取要素 id，properties.name 取 label", () => {
    const geojson = buildCitiesGeoJson(SAMPLE_FEATURES);
    geojson.features.forEach((feature, index) => {
      const source = SAMPLE_FEATURES[index];
      expect(feature.properties.id).toBe(source?.id);
      expect(feature.properties.name).toBe(source?.label);
    });
  });

  it("坐标为 [lon, lat] 顺序", () => {
    const geojson = buildCitiesGeoJson(SAMPLE_FEATURES);
    geojson.features.forEach((feature, index) => {
      const source = SAMPLE_FEATURES[index];
      expect(feature.geometry.coordinates).toEqual([source?.coordinate.lon, source?.coordinate.lat]);
    });
  });

  it("空要素集输出空 FeatureCollection", () => {
    const geojson = buildCitiesGeoJson([]);
    expect(geojson.features).toEqual([]);
  });
});
