/**
 * DXF 归一化：预览只关心「形状画得对不对」—— 块引用要按插入变换展开、多段线 bulge
 * 要变成圆弧、范围要覆盖文字，否则缩放/适应范围会明显跑偏。
 */
import { describe, expect, it } from "vitest";
import { parseDxf } from "@/lib/dxf";

/** 最小 ASCII DXF：一个块 DOOR + 常见 2D 实体。 */
const SAMPLE = `0
SECTION
2
HEADER
0
ENDSEC
0
SECTION
2
TABLES
0
TABLE
2
LAYER
70
1
0
LAYER
2
0
70
0
62
7
6
CONTINUOUS
0
ENDTAB
0
ENDSEC
0
SECTION
2
BLOCKS
0
BLOCK
2
DOOR
70
0
10
0
20
0
30
0
0
LINE
8
0
10
0
20
0
30
0
11
10
21
0
31
0
0
ENDBLK
0
ENDSEC
0
SECTION
2
ENTITIES
0
LINE
8
0
10
0
20
0
30
0
11
100
21
0
31
0
0
CIRCLE
8
0
10
50
20
50
30
0
40
10
0
LWPOLYLINE
8
0
90
3
70
1
10
0
20
100
10
100
20
100
10
100
20
200
0
ARC
8
0
10
0
20
0
30
0
40
20
50
0
51
90
0
TEXT
8
0
10
0
20
300
30
0
40
5
1
HELLO
0
INSERT
8
0
2
DOOR
10
200
20
0
30
0
41
2
42
2
50
90
0
INSERT
8
0
2
MISSING
10
0
20
0
30
0
0
POINT
8
0
10
5
20
5
30
0
0
ENDSEC
0
EOF
`;

describe("parseDxf", () => {
  it("把常见实体归一化成折线 / 文字 / 点，并统计顶层实体数", () => {
    const drawing = parseDxf(SAMPLE);
    expect(drawing.entityCount).toBe(8);
    expect(drawing.paths).toHaveLength(5); // LINE / CIRCLE / LWPOLYLINE / ARC / 块内 LINE（点与文字不占路径）
    expect(drawing.texts).toHaveLength(1);
    expect(drawing.dots).toHaveLength(1);
    expect(drawing.skipped).toBe(1); // 指向不存在的块
    expect(drawing.truncated).toBe(false);
  });

  it("闭合多段线保留 closed 标记；圆也是闭合路径", () => {
    const drawing = parseDxf(SAMPLE);
    expect(drawing.paths.filter((path) => path.closed)).toHaveLength(2); // 圆 + 闭合多段线（块内 LINE 不闭合）
  });

  it("块引用按平移 / 旋转 / 缩放展开", () => {
    const drawing = parseDxf(SAMPLE);
    const points = drawing.paths.flatMap((path) => path.points);
    // 块内 (0,0)-(10,0)，scale 2、rot 90°、插入点 (200,0) → (200,0)-(200,20)。
    expect(points.some((point) => Math.abs(point.x - 200) < 1e-6 && Math.abs(point.y) < 1e-6)).toBe(true);
    expect(points.some((point) => Math.abs(point.x - 200) < 1e-6 && Math.abs(point.y - 20) < 1e-6)).toBe(true);
  });

  it("范围覆盖几何与文字（文字按字高 × 字符数估算宽度）", () => {
    const drawing = parseDxf(SAMPLE);
    expect(drawing.bounds).not.toBeNull();
    expect(drawing.bounds!.minX).toBeCloseTo(0, 5);
    expect(drawing.bounds!.minY).toBeCloseTo(0, 5);
    expect(drawing.bounds!.maxX).toBeCloseTo(200, 5);
    // 文字基线 y=300、字高 5 → 顶部 305。
    expect(drawing.bounds!.maxY).toBeCloseTo(305, 5);
  });

  it("多段线 bulge 采样成圆弧而不是直线", () => {
    const dxf = `0
SECTION
2
ENTITIES
0
LWPOLYLINE
8
0
90
2
70
0
10
0
20
0
42
1
10
10
20
0
0
ENDSEC
0
EOF
`;
    const drawing = parseDxf(dxf);
    expect(drawing.paths).toHaveLength(1);
    const path = drawing.paths[0];
    expect(path.points.length).toBeGreaterThan(2);
    expect(Math.max(...path.points.map((point) => Math.abs(point.y)))).toBeGreaterThan(1);
  });

  it("非法内容抛出可展示的错误", () => {
    expect(() => parseDxf("")).toThrow();
    expect(() => parseDxf("not a dxf")).toThrow();
  });
});
