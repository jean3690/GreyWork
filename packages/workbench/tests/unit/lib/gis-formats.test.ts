/**
 * TopoJSON → GeoJSON：拓扑编码必须真的展开，而不是原样透传。
 *
 * 这里也守住「坏数据给人话错误」：TopoJSON 少了 objects / arcs 时，硬塞给 topojson-client
 * 只会得到一个内部异常，用户看到的是「Cannot read properties of undefined」。
 */
import { describe, expect, it } from "vitest";
import { parseTopoJsonText } from "@/lib/gis-formats";

const TOPO = {
  type: "Topology",
  // 一个无 transform 的拓扑：arcs 里是绝对坐标。
  arcs: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 0],
    ],
  ],
  objects: {
    region: {
      type: "Polygon",
      arcs: [[0]],
      properties: { name: "r" },
    },
    route: {
      type: "LineString",
      arcs: [0],
      properties: { name: "l" },
    },
  },
};

describe("parseTopoJsonText", () => {
  it("展开 objects 里的每个对象，合并成一个 FeatureCollection", () => {
    const collection = parseTopoJsonText(JSON.stringify(TOPO));
    expect(collection.features).toHaveLength(2);
    expect(collection.features.map((feature) => (feature.geometry as { type: string }).type)).toEqual(["Polygon", "LineString"]);
    expect(collection.features[0].properties).toEqual({ name: "r" });
  });

  it("objects 为空时给空集合（由预览提示「没有要素」）", () => {
    const collection = parseTopoJsonText(JSON.stringify({ type: "Topology", arcs: [], objects: {} }));
    expect(collection.features).toHaveLength(0);
  });

  it("非法 JSON 与非 TopoJSON 给可区分的人话错误", () => {
    expect(() => parseTopoJsonText("{oops")).toThrow(/不是合法 JSON/);
    expect(() => parseTopoJsonText(JSON.stringify({ type: "FeatureCollection", features: [] }))).toThrow(/不是合法的 TopoJSON/);
    // 缺 arcs 的「半截拓扑」同样挡在解析前，而不是让 topojson-client 内部抛。
    expect(() => parseTopoJsonText(JSON.stringify({ type: "Topology", objects: {} }))).toThrow(/不是合法的 TopoJSON/);
  });
});
