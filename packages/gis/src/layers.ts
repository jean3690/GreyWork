import type { GeoFeature, GeoLayer, GeoLayerKind } from "./types";

export const DEFAULT_LAYERS: GeoLayer[] = [
  { id: "terrain", name: "地形", kind: "terrain", visible: true },
  { id: "imagery", name: "影像", kind: "imagery", visible: false },
  { id: "vector", name: "矢量", kind: "vector", visible: true },
  { id: "live", name: "实时态势", kind: "live", visible: true },
];

export const SAMPLE_FEATURES: GeoFeature[] = [
  { id: "beijing", label: "北京 · ICP 节点", coordinate: { lon: 116.3913, lat: 39.9075 }, layer: "live", height: 44 },
  { id: "shanghai", label: "上海 · 空间计算中心", coordinate: { lon: 121.4737, lat: 31.2304 }, layer: "vector", height: 62 },
  { id: "shenzhen", label: "深圳 · 智慧城市样板", coordinate: { lon: 114.0579, lat: 22.5431 }, layer: "vector", height: 38 },
  { id: "newyork", label: "纽约 · 数据交换枢纽", coordinate: { lon: -74.006, lat: 40.7128 }, layer: "live", height: 51 },
  { id: "berlin", label: "柏林 · 开源协作枢纽", coordinate: { lon: 13.405, lat: 52.52 }, layer: "vector", height: 42 },
  { id: "singapore", label: "新加坡 · 亚太网关", coordinate: { lon: 103.8198, lat: 1.3521 }, layer: "live", height: 55 },
  { id: "sydney", label: "悉尼 · 遥感数据站", coordinate: { lon: 151.2093, lat: -33.8688 }, layer: "terrain", height: 29 },
  { id: "cairo", label: "开罗 · 环境监测点", coordinate: { lon: 31.2357, lat: 30.0444 }, layer: "terrain", height: 33 },
];

export function visibleFeatures(layers: GeoLayer[], features: GeoFeature[]): GeoFeature[] {
  const visibleLayerIds = new Set(layers.filter((layer) => layer.visible).map((layer) => layer.id));
  return features.filter((feature) => visibleLayerIds.has(feature.layer));
}

export function layerKindLabel(kind: GeoLayerKind): string {
  const labels: Record<GeoLayerKind, string> = {
    terrain: "地形",
    imagery: "影像",
    vector: "矢量",
    live: "实时",
  };
  return labels[kind];
}
