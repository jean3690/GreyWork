/**
 * CSV 经纬度列 → GeoJSON 点集合（纯逻辑，便于单测）。
 *
 * 与 `lib/csv.ts` 分开：那边只负责「把文本切成格子」，这边负责「哪两列是坐标、怎么变成
 * 要素」。分开后两边都能独立测，也避免表格查看器为了地图去理解几何。
 *
 * **列名只认常见写法，不猜**：lon / lng / long / longitude / x / 经度 与
 * lat / latitude / y / 纬度。认不出来就不提供地图入口 —— 猜错一列画出来的图，
 * 比没有入口更糟（用户会以为数据有问题）。
 */
import type { GeoJsonFeature, GeoJsonFeatureCollection } from "./geojson";

const LON_HEADERS = new Set(["lon", "lng", "long", "longitude", "x", "经度"]);
const LAT_HEADERS = new Set(["lat", "latitude", "y", "纬度"]);

export interface CsvGeoColumns {
  lonIndex: number;
  latIndex: number;
  lon: string;
  lat: string;
}

export interface CsvGeoResult {
  collection: GeoJsonFeatureCollection;
  columns: CsvGeoColumns;
  /** 坐标为空或不是数字的行数（这些行不会进地图，但表格里还在）。 */
  skipped: number;
}

/** 表头的比较口径：去 BOM / 空白 / 大小写。 */
function normalizeHeader(name: string): string {
  return name
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase();
}

/** 找出经纬度列；找不到（或缺一列）返回 null。 */
export function detectLonLatColumns(header: string[]): CsvGeoColumns | null {
  const normalized = header.map(normalizeHeader);
  const lonIndex = normalized.findIndex((name) => LON_HEADERS.has(name));
  const latIndex = normalized.findIndex((name) => LAT_HEADERS.has(name));
  if (lonIndex < 0 || latIndex < 0 || lonIndex === latIndex) return null;
  return { lonIndex, latIndex, lon: header[lonIndex].trim(), lat: header[latIndex].trim() };
}

function parseCoordinate(cell: string | undefined): number | null {
  const text = cell?.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * 把 CSV 行转成点要素集合；表头里没有经纬度列时返回 null（UI 据此不提供地图模式）。
 *
 * **不校验经纬度范围**：投影坐标（米）在预览里会由 MapViewer 的质控提示统一处理，
 * 这里提前按「±180/±90」过滤只会把整份数据悄悄丢光，反而更难查。
 * 每个要素带 `_row`（CSV 里的行号，表头是第 1 行），方便点击点位后回表格对照。
 */
export function csvToPointCollection(header: string[], body: string[][]): CsvGeoResult | null {
  const columns = detectLonLatColumns(header);
  if (!columns) return null;

  const features: GeoJsonFeature[] = [];
  let skipped = 0;
  for (const [index, row] of body.entries()) {
    const lon = parseCoordinate(row[columns.lonIndex]);
    const lat = parseCoordinate(row[columns.latIndex]);
    if (lon === null || lat === null) {
      skipped += 1;
      continue;
    }
    const properties: Record<string, unknown> = {};
    for (const [column, value] of header.entries()) {
      if (column === columns.lonIndex || column === columns.latIndex) continue;
      const key = value.trim();
      if (key) properties[key] = row[column] ?? "";
    }
    if (!("_row" in properties)) properties._row = index + 2;
    features.push({
      type: "Feature",
      properties,
      geometry: { type: "Point", coordinates: [lon, lat] },
    });
  }

  return { collection: { type: "FeatureCollection", features }, columns, skipped };
}
