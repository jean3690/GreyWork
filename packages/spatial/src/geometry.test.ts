import { describe, expect, it } from "vitest";
import { DEG2RAD, buildSphereGrid, fitPointCloud, orient, rotateX, rotateY, sphericalToCartesian } from "./geometry";

const norm = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);

describe("sphericalToCartesian", () => {
  it("赤道本初子午点落在 +x 轴", () => {
    expect(sphericalToCartesian(0, 0)).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("极点收敛到 ±y 轴（与经度无关）", () => {
    const north = sphericalToCartesian(90, 37);
    expect(north.x).toBeCloseTo(0, 12);
    expect(north.y).toBeCloseTo(1, 12);
    expect(north.z).toBeCloseTo(0, 12);
    expect(sphericalToCartesian(-90, -123).y).toBeCloseTo(-1, 12);
  });

  it("lat=0, lon=90 落在 +z 轴", () => {
    const p = sphericalToCartesian(0, 90);
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.z).toBeCloseTo(1, 12);
  });

  it("任意点的模长恒等于半径（勾股恒等式，公式错则破）", () => {
    for (const [lat, lon, r] of [
      [45, 45, 1],
      [-33.8688, 151.2093, 2.5],
      [12, -77, 0.3],
    ] as const) {
      expect(norm(sphericalToCartesian(lat, lon, r))).toBeCloseTo(r, 12);
    }
  });

  it("lat=45, lon=45 的分量满足 cos·cos 分解", () => {
    const p = sphericalToCartesian(45, 45);
    expect(p.x).toBeCloseTo(Math.cos(Math.PI / 4) ** 2, 12);
    expect(p.y).toBeCloseTo(Math.SQRT1_2, 12);
    expect(p.z).toBeCloseTo(Math.cos(Math.PI / 4) ** 2, 12);
  });
});

describe("rotateY / rotateX", () => {
  it("绕 Y 转 90°：+x -> -z", () => {
    const r = rotateY({ x: 1, y: 0, z: 0 }, Math.PI / 2);
    expect(r.x).toBeCloseTo(0, 12);
    expect(r.z).toBeCloseTo(-1, 12);
    expect(r.y).toBe(0);
  });

  it("绕 X 转 90°：+y -> +z", () => {
    const r = rotateX({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    expect(r.y).toBeCloseTo(0, 12);
    expect(r.z).toBeCloseTo(1, 12);
  });

  it("旋转保持模长不变", () => {
    const v = sphericalToCartesian(23.5, 111, 3);
    expect(norm(rotateY(v, 0.7))).toBeCloseTo(3, 10);
    expect(norm(rotateX(v, -1.2))).toBeCloseTo(3, 10);
  });

  it("正转再反转回到原向量（可逆性）", () => {
    const v = sphericalToCartesian(40, 60, 2);
    const back = rotateY(rotateY(v, 1.1), -1.1);
    expect(back.x).toBeCloseTo(v.x, 10);
    expect(back.y).toBeCloseTo(v.y, 10);
    expect(back.z).toBeCloseTo(v.z, 10);
  });
});

describe("orient", () => {
  it("depth 等于旋转后 z 坐标", () => {
    const pts = [{ x: 0, y: 0, z: 1 }];
    const out = orient(pts, 0, Math.PI); // 绕 X 转 180°，z 变 -1
    expect(out[0].depth).toBeCloseTo(-1, 10);
    expect(out[0].visible).toBe(false); // -1 < -0.45 阈值
  });

  it("阈值边界：z 恰为 -0.45 时不可见，略高于则可见", () => {
    // rotX=0 时 depth 就是原始 z
    expect(orient([{ x: 0, y: 0, z: -0.45 }], 0, 0)[0].visible).toBe(false);
    expect(orient([{ x: 0, y: 0, z: -0.4499 }], 0, 0)[0].visible).toBe(true);
  });

  it("逐点变换且顺序保持", () => {
    const pts = [sphericalToCartesian(0, 0), sphericalToCartesian(45, 90, 1)];
    const out = orient(pts, 0.5, -0.3);
    expect(out).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(out[i].position).toEqual(rotateX(rotateY(pts[i], 0.5), -0.3));
      expect(out[i].depth).toBe(out[i].position.z);
    }
  });
});

describe("buildSphereGrid", () => {
  it("默认 30° 步长生成 7 行 × 12 列 = 84 点", () => {
    expect(buildSphereGrid()).toHaveLength(7 * 12);
  });

  it("自定义步长按行×列计数", () => {
    // lat: -90..90 步 90 → 3 行；lon: -180..<180 步 120 → 3 列
    expect(buildSphereGrid(90, 120)).toHaveLength(9);
  });

  it("所有网格点都在球面上且含两个极点", () => {
    const grid = buildSphereGrid(30, 60, 2);
    for (const p of grid) expect(norm(p)).toBeCloseTo(2, 12);
    const poles = grid.filter((p) => Math.abs(p.y) > 1.999);
    expect(poles).toHaveLength(2 * 6); // 每个经度列各含南北极点
    for (const pole of poles) {
      expect(pole.x).toBeCloseTo(0, 12);
      expect(pole.z).toBeCloseTo(0, 12);
    }
  });
});

describe("fitPointCloud", () => {
  it("按半径等比缩放所有点位", () => {
    const oriented = orient(
      [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 2, z: -1 },
      ],
      0,
      0,
    );
    const fitted = fitPointCloud(oriented, 10);
    expect(fitted[0]).toEqual({ x: 10, y: 0, z: 0 });
    expect(fitted[1]).toEqual({ x: 0, y: 20, z: -10 });
  });

  it("输入为空时返回空数组", () => {
    expect(fitPointCloud([], 5)).toEqual([]);
  });
});

describe("DEG2RAD", () => {
  it("与 π/180 一致", () => {
    expect(DEG2RAD).toBeCloseTo(0.017453292519943295, 15);
  });
});
