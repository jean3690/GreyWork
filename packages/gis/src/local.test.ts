import { describe, expect, it } from "vitest";
import { SAMPLE_LOCAL_SOURCES, createLocalSpatialSource, describeLocalSource } from "./local";

describe("createLocalSpatialSource", () => {
  it("显式 name 时逐字段保留", () => {
    const s = createLocalSpatialSource("demo", "3dtiles", "/data/demo/tileset.json", "示例瓦片");
    expect(s).toEqual({ id: "demo", type: "3dtiles", path: "/data/demo/tileset.json", name: "示例瓦片" });
  });

  it("缺省 name 回退为类型名", () => {
    expect(createLocalSpatialSource("cities", "geojson", "/tmp/cities.geojson").name).toBe("geojson");
    // layers 字段可选，不传时不应出现
    expect(createLocalSpatialSource("x", "raster", "/p")).not.toHaveProperty("layers");
  });
});

describe("describeLocalSource", () => {
  it("按 name · type · path 拼接", () => {
    const s = createLocalSpatialSource("t", "mbtiles", "/data/t.mbtiles", "地形");
    expect(describeLocalSource(s)).toBe("地形 · mbtiles · /data/t.mbtiles");
  });

  it("name 为类型回退值时同样成立", () => {
    const s = createLocalSpatialSource("g", "geojson", "/a.geojson");
    expect(describeLocalSource(s)).toBe("geojson · geojson · /a.geojson");
  });
});

describe("SAMPLE_LOCAL_SOURCES", () => {
  it("三条样例 id 唯一且类型各异", () => {
    const ids = SAMPLE_LOCAL_SOURCES.map((s) => s.id);
    const types = SAMPLE_LOCAL_SOURCES.map((s) => s.type);
    expect(new Set(ids).size).toBe(ids.length);
    expect(types).toEqual(["3dtiles", "geojson", "mbtiles"]);
    for (const s of SAMPLE_LOCAL_SOURCES) {
      expect(s.path.length).toBeGreaterThan(0);
      expect(describeLocalSource(s)).toContain(s.id === "" ? "?" : s.name);
    }
  });
});
