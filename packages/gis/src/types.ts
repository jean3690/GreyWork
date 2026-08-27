import type { Vector3 } from "@greywork/core";

/** 经纬度坐标（WGS84） */
export interface Coordinate {
  lon: number;
  lat: number;
}

export type GeoLayerKind = "terrain" | "imagery" | "vector" | "live";

/** 可在 GIS 视图中独立开关的图层 */
export interface GeoLayer {
  id: string;
  name: string;
  kind: GeoLayerKind;
  visible: boolean;
}

/** 带 GIS 语义的空间要素（点位、事件、区域） */
export interface GeoFeature {
  id: string;
  label: string;
  coordinate: Coordinate;
  layer: string;
  height?: number;
  properties?: Record<string, unknown>;
}

/** Web 墨卡托像素坐标 */
export interface MercatorPixel {
  x: number;
  y: number;
}

/** 瓦片地址 */
export interface TileAddress {
  z: number;
  x: number;
  y: number;
}

/** 地图视角状态 */
export interface ViewState {
  center: Coordinate;
  zoom: number;
  bounds?: { min: Coordinate; max: Coordinate };
}

export interface ProjectedFeature extends GeoFeature {
  pixel: MercatorPixel;
  screen: { x: number; y: number; depth: number } | null;
  vector: Vector3;
}
