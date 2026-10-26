/**
 * CSV 经纬度列 → 点集合：识别口径与降级的契约。
 *
 * 1. 列名只认常见写法，认不出来返回 null（UI 据此不给地图入口）；
 * 2. 坐标缺失 / 非数字的行跳过并计数 —— 表格里那几行还在，地图上少几个点必须能解释；
 * 3. **不按 ±180/±90 过滤**：投影坐标留给 MapViewer 的质控提示，静默丢光更难查。
 */
import { describe, expect, it } from "vitest";
import { csvToPointCollection, detectLonLatColumns } from "@/lib/csv-geo";

describe("detectLonLatColumns", () => {
  it("认常见英文列名（大小写不敏感）", () => {
    expect(detectLonLatColumns(["name", "LON", "Lat"])).toMatchObject({ lon: "LON", lat: "Lat", lonIndex: 1, latIndex: 2 });
    expect(detectLonLatColumns(["longitude", "latitude"])).toMatchObject({ lonIndex: 0, latIndex: 1 });
    expect(detectLonLatColumns(["lng", "lat"])).toMatchObject({ lonIndex: 0, latIndex: 1 });
  });

  it("认中文列名与 x / y", () => {
    expect(detectLonLatColumns(["名称", "经度", "纬度"])).toMatchObject({ lonIndex: 1, latIndex: 2 });
    expect(detectLonLatColumns(["x", "y"])).toMatchObject({ lonIndex: 0, latIndex: 1 });
  });

  it("缺一列或找不到时返回 null（不猜）", () => {
    expect(detectLonLatColumns(["name", "lon"])).toBeNull();
    expect(detectLonLatColumns(["name", "qty"])).toBeNull();
    expect(detectLonLatColumns([])).toBeNull();
  });

  it("表头带 BOM / 空白也能认", () => {
    expect(detectLonLatColumns(["\uFEFFlon ", " lat"])).toMatchObject({ lonIndex: 0, latIndex: 1 });
  });
});

describe("csvToPointCollection", () => {
  it("坐标列之外的列都成为属性，并补上 CSV 行号 _row", () => {
    const result = csvToPointCollection(
      ["name", "lon", "lat", "qty"],
      [
        ["a", "116.39", "39.9", "3"],
        ["b", "117", "40", "4"],
      ],
    );
    expect(result?.skipped).toBe(0);
    expect(result?.collection.features).toHaveLength(2);
    expect(result?.collection.features[0]).toMatchObject({
      type: "Feature",
      properties: { name: "a", qty: "3", _row: 2 },
      geometry: { type: "Point", coordinates: [116.39, 39.9] },
    });
  });

  it("坐标为空或不是数字的行跳过并计数", () => {
    const result = csvToPointCollection(["lon", "lat"], [["116", "39"], ["", "39"], ["abc", "39"], ["117"]]);
    expect(result?.collection.features).toHaveLength(1);
    expect(result?.skipped).toBe(3);
  });

  it("超出经纬度范围的行**保留**（投影坐标由 MapViewer 提示，不在这里静默丢）", () => {
    const result = csvToPointCollection(["x", "y"], [["500000", "4649776"]]);
    expect(result?.collection.features).toHaveLength(1);
    expect(result?.skipped).toBe(0);
  });

  it("没有坐标列时返回 null", () => {
    expect(csvToPointCollection(["name", "qty"], [["a", "1"]])).toBeNull();
  });

  it("表头里的 _row 不被覆盖", () => {
    const result = csvToPointCollection(["_row", "lon", "lat"], [["99", "116", "39"]]);
    expect(result?.collection.features[0].properties?._row).toBe("99");
  });
});
