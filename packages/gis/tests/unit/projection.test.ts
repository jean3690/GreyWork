import { describe, expect, it } from "vitest";
import {
  EARTH_RADIUS,
  TILE_SIZE,
  lonLatToWebMercator,
  formatCoordinate,
  tileAddress,
  toRad,
  webMercatorToLonLat,
} from "../../src/projection";

/** Web 墨卡托规范的最大纬度（y 归一化到 [0, world] 的边界） */
const MAX_LAT = (Math.atan(Math.sinh(Math.PI)) * 180) / Math.PI;

describe("toRad", () => {
  it("按 π/180 换算", () => {
    expect(toRad(180)).toBeCloseTo(Math.PI, 12);
    expect(toRad(0)).toBe(0);
    expect(toRad(-90)).toBeCloseTo(-Math.PI / 2, 12);
  });
});

describe("lonLatToWebMercator", () => {
  it("zoom=0 时原点落在 256 画布中心", () => {
    const p = lonLatToWebMercator({ lon: 0, lat: 0 });
    expect(p.x).toBeCloseTo(TILE_SIZE / 2, 9);
    expect(p.y).toBeCloseTo(TILE_SIZE / 2, 9);
  });

  it("经度 ±180 映射到画布左右边缘（赤道处）", () => {
    expect(lonLatToWebMercator({ lon: -180, lat: 0 }).x).toBeCloseTo(0, 9);
    expect(lonLatToWebMercator({ lon: 180, lat: 0 }).x).toBeCloseTo(TILE_SIZE, 9);
  });

  it("墨卡托边界纬度 ±85.0511… 精确映射到画布上下边缘", () => {
    // 边界纬度由 y = R·π 反解而来，不是任意取的数
    expect(MAX_LAT).toBeGreaterThan(85.05);
    expect(MAX_LAT).toBeLessThan(85.06);
    const top = lonLatToWebMercator({ lon: 0, lat: MAX_LAT });
    const bottom = lonLatToWebMercator({ lon: 0, lat: -MAX_LAT });
    expect(top.y).toBeCloseTo(0, 6);
    expect(bottom.y).toBeCloseTo(TILE_SIZE, 5);
    // 越界纬度会溢出画布（投影本身不裁剪，但方向必须正确）
    expect(lonLatToWebMercator({ lon: 0, lat: 89 }).y).toBeLessThan(0);
  });

  it("像素坐标随 zoom 按 2 的幂缩放", () => {
    for (const zoom of [1, 3, 8]) {
      const base = lonLatToWebMercator({ lon: 121.4737, lat: 31.2304 });
      const scaled = lonLatToWebMercator({ lon: 121.4737, lat: 31.2304 }, zoom);
      expect(scaled.x).toBeCloseTo(base.x * 2 ** zoom, 6);
      expect(scaled.y).toBeCloseTo(base.y * 2 ** zoom, 6);
    }
  });
});

describe("webMercatorToLonLat 往返", () => {
  it("与正向变换互逆，误差在浮点精度内", () => {
    const samples = [
      { lon: 116.3913, lat: 39.9075 },
      { lon: -74.006, lat: 40.7128 },
      { lon: 103.8198, lat: 1.3521 },
      { lon: 151.2093, lat: -33.8688 },
      { lon: 0, lat: 0 },
      { lon: 179.9, lat: 84 },
    ];
    for (const coord of samples) {
      for (const zoom of [0, 5]) {
        const pixel = lonLatToWebMercator(coord, zoom);
        const back = webMercatorToLonLat(pixel, zoom);
        expect(back.lon).toBeCloseTo(coord.lon, 8);
        expect(back.lat).toBeCloseTo(coord.lat, 8);
      }
    }
  });

  it("逆变换在画布边缘还原出边界纬度", () => {
    const top = webMercatorToLonLat({ x: TILE_SIZE / 2, y: 0 });
    const bottom = webMercatorToLonLat({ x: TILE_SIZE / 2, y: TILE_SIZE });
    expect(top.lat).toBeCloseTo(MAX_LAT, 6);
    expect(bottom.lat).toBeCloseTo(-MAX_LAT, 6);
  });
});

describe("tileAddress", () => {
  it("给出符合 slippy map 规范的已知瓦片号", () => {
    // 北京 z=3 -> x=6,y=3；纽约 z=3 -> x=2,y=3（OSM 对照值）
    expect(tileAddress({ lon: 116.3913, lat: 39.9075 }, 3)).toEqual({ z: 3, x: 6, y: 3 });
    expect(tileAddress({ lon: -74.006, lat: 40.7128 }, 3)).toEqual({ z: 3, x: 2, y: 3 });
  });

  it("西经坐标不会产生负瓦片号", () => {
    const t = tileAddress({ lon: -122.4194, lat: 37.7749 }, 2); // 旧金山
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.y).toBeGreaterThanOrEqual(0);
    expect(t.y).toBeLessThan(2 ** 2);
  });

  it("瓦片号随 zoom 加倍保持父级关系", () => {
    const z2 = tileAddress({ lon: 13.405, lat: 52.52 }, 2);
    const z3 = tileAddress({ lon: 13.405, lat: 52.52 }, 3);
    expect(z3.x).toBe(z2.x * 2 || z2.x * 2 + 1 === z3.x ? z3.x : -1);
    expect([z2.x * 2, z2.x * 2 + 1]).toContain(z3.x);
    expect([z2.y * 2, z2.y * 2 + 1]).toContain(z3.y);
  });

  it("默认 zoom 为 1", () => {
    expect(tileAddress({ lon: 0, lat: 85 })).toEqual({ z: 1, x: 1, y: 0 });
  });
});

describe("formatCoordinate", () => {
  it("默认保留三位小数并带度符号", () => {
    expect(formatCoordinate({ lon: 116.3913, lat: 39.9075 })).toBe("116.391°, 39.907°");
    expect(formatCoordinate({ lon: -74.006, lat: 40.7128 })).toBe("-74.006°, 40.713°");
  });

  it("precision=0 时四舍五入到整度", () => {
    expect(formatCoordinate({ lon: 116.6, lat: -39.5 }, 0)).toBe("117°, -40°");
  });
});

describe("常量", () => {
  it("EARTH_RADIUS 与 TILE_SIZE 符合 WGS84/瓦片规范", () => {
    expect(EARTH_RADIUS).toBe(6378137);
    expect(TILE_SIZE).toBe(256);
  });
});
