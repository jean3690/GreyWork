/**
 * KML / KMZ / GPX / TopoJSON → GeoJSON 归一化（纯逻辑，便于单测）。
 *
 * MapViewer 只认一种形状（FeatureCollection，见 `lib/geojson.ts`），所以格式差异全部
 * 在这里消化掉，渲染层不必知道数据原来是 XML 还是 TopoJSON。
 *
 * 为什么收这四种而不收更多：
 * - KML / KMZ 是 GIS 交付里最常见的交换格式，KMZ 就是 zip 里装一个 KML；
 * - GPX 是轨迹（航点 / 路线 / 轨迹段），togeojson 同一个库就能解；
 * - TopoJSON 是 TopoJSON 生态的默认产出（行政区划边界尤其常见），拓扑编码无法当普通
 *   GeoJSON 读 —— 必须走 topojson-client 展开成具体几何。
 * **CSV 的经纬度列不在此列**：.csv 已经分派给表格查看器，同一扩展名没法同时开两个
 * viewer（那需要一套「表格 / 地图」切换，属于另一个功能，不在预览分派里硬塞）。
 *
 * XML 解析用宿主自带的 DOMParser：togeojson 要的是 XML DOM 而不是字符串。
 * 非法 XML 时 DOMParser **不抛异常**，而是返回带 `<parsererror>` 的文档 —— 必须自己查，
 * 否则会得到一张空图。
 */
import { gpx as gpxToGeoJson, kml as kmlToGeoJson } from "@tmcw/togeojson";
import { feature as topoJsonFeature } from "topojson-client";
import type { Topology } from "topojson-specification";
import { toFeatureCollection, type GeoJsonFeatureCollection } from "./geojson";

/**
 * topojson-client 的 `feature()` 按「单个几何类型」重载，而我们要遍历 objects 的联合类型。
 * 这一处断言把重载收敛成一个签名；返回值的两种可能（Feature / FeatureCollection）在这里
 * 显式列出，避免把 `any` 漏到调用方。
 */
type TopoObject = Topology["objects"][string];
type TopoConverted = { type: "FeatureCollection"; features: unknown[] } | { type: "Feature" };
const convertTopoObject = topoJsonFeature as unknown as (topology: Topology, object: TopoObject) => TopoConverted;

function parseXml(text: string, label: string): Document {
  if (typeof DOMParser === "undefined") throw new Error(`当前运行环境没有 XML 解析器，无法读取 ${label}`);
  const document = new DOMParser().parseFromString(text, "text/xml");
  // DOMParser 对非法 XML 给的是带 <parsererror> 的文档，而不是异常。
  if (document.getElementsByTagName("parsererror").length > 0) throw new Error(`${label} 不是合法的 XML`);
  return document;
}

/** togeojson 的输出理论上就是 FeatureCollection；归一失败说明文件结构不对。 */
function normalized(converted: unknown, label: string): GeoJsonFeatureCollection {
  const collection = toFeatureCollection(converted);
  if (!collection) throw new Error(`${label} 无法转换成 GeoJSON`);
  return collection;
}

/** KML 文本 → FeatureCollection。空 KML 是合法的，返回空集合（由 UI 提示「没有要素」）。 */
export function parseKmlText(text: string): GeoJsonFeatureCollection {
  return normalized(kmlToGeoJson(parseXml(text, "KML")), "KML");
}

/** GPX 文本 → FeatureCollection（航点 / 路线 / 轨迹段都会变成要素）。 */
export function parseGpxText(text: string): GeoJsonFeatureCollection {
  return normalized(gpxToGeoJson(parseXml(text, "GPX")), "GPX");
}

/**
 * KMZ（zip 里的 KML）→ KML 文本。
 *
 * KMZ 里可能有多个 `.kml`（主文档 + 网络链接的覆盖物）；取第一个即可 —— 预览不需要
 * 判断哪个是根文档，多份文档在视觉上也只是叠着画。
 */
export async function kmzToKmlText(bytes: Uint8Array): Promise<string> {
  // jszip 只在打开 .kmz 时才需要（geojson / kml / gpx 用不到），静态 import 会把它
  // 焊进 MapViewer 的 chunk —— 动态 import 让常见格式的加载路径不付这份代价。
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  const [entry] = zip.file(/\.kml$/i);
  if (!entry) throw new Error("KMZ 里没有 .kml 文件");
  return entry.async("text");
}

/**
 * TopoJSON 文本 → FeatureCollection。
 *
 * 一个文件里的 `objects` 可以有任意多个（常见于「省界 / 市界 / 县界」分层），逐个展开后
 * 合并成一个集合 —— 预览不做图层管理，全部画出来即可。
 */
export function parseTopoJsonText(text: string): GeoJsonFeatureCollection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const topology = asTopology(parsed);
  if (!topology) throw new Error("不是合法的 TopoJSON（缺 type: Topology、objects 或 arcs）");

  const features: unknown[] = [];
  for (const object of Object.values(topology.objects)) {
    const converted = convertTopoObject(topology, object);
    if (converted.type === "FeatureCollection") features.push(...converted.features);
    else features.push(converted);
  }
  return normalized({ type: "FeatureCollection", features }, "TopoJSON");
}

function asTopology(input: unknown): Topology | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  if (record.type !== "Topology") return null;
  if (typeof record.objects !== "object" || record.objects === null) return null;
  if (!Array.isArray(record.arcs)) return null;
  return record as unknown as Topology;
}
