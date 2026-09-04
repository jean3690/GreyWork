import { formatNumber } from "@greywork/core";

export type SpatialFormat = "geojson" | "mbtiles" | "3dtiles" | "kml" | "shp";

export interface SpatialBBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface ParsedSpatialData {
  format: SpatialFormat;
  name: string;
  sourcePath: string;
  crs?: string;
  bbox?: SpatialBBox;
  featureCount?: number;
  tileCount?: number;
  layers?: string[];
}

export const SUPPORTED_FORMATS: SpatialFormat[] = ["geojson", "mbtiles", "3dtiles", "kml", "shp"];

export const FORMAT_LABELS: Record<SpatialFormat, string> = {
  geojson: "GeoJSON",
  mbtiles: "MBTiles",
  "3dtiles": "3D Tiles",
  kml: "KML",
  shp: "Shapefile",
};

export function createSpatialDescriptor(
  format: SpatialFormat,
  name: string,
  sourcePath: string,
  extras: Partial<Omit<ParsedSpatialData, "format" | "name" | "sourcePath">> = {},
): ParsedSpatialData {
  return { format, name, sourcePath, ...extras };
}

export function describeSpatialData(data: ParsedSpatialData): string {
  let detail: string;
  if (data.bbox) {
    const b = data.bbox;
    detail =
      "bbox " + formatNumber(b.minLon) + "," + formatNumber(b.minLat) + " → " + formatNumber(b.maxLon) + "," + formatNumber(b.maxLat);
  } else {
    const count = data.featureCount ?? data.tileCount;
    detail = count == null ? "?" : String(count) + " records";
  }
  return FORMAT_LABELS[data.format] + " · " + data.name + " · " + detail;
}
