import type { QueryResultFormat } from "./types";
import type { DuckDbClient, GeoJsonFeatureCollection, QueryResult, SpatialDataset } from "./types";

function randomDuration(): number {
  return 8 + Math.floor(Math.random() * 40);
}

function makeResult(sql: string, format: QueryResultFormat): QueryResult {
  const columns = ["id", "name", "lon", "lat", "value"];
  const rows: unknown[][] = [
    ["pt-001", "北京站", 116.3913, 39.9075, 1284],
    ["pt-002", "上海站", 121.4737, 31.2304, 2231],
    ["pt-003", "深圳站", 114.0579, 22.5431, 876],
  ];
  return {
    columns,
    rows,
    rowCount: rows.length,
    durationMs: randomDuration(),
    format,
    truncated: sql.includes("LIMIT 10"),
  };
}

export const SPATIAL_SQL_TEMPLATES = {
  readGeoJson: (table: string, path: string) => `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_geojson('${path}');`,
  readCsv: (table: string, path: string) => `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_csv_auto('${path}');`,
  bbox: (table: string, minLon: number, minLat: number, maxLon: number, maxLat: number) =>
    `SELECT * FROM ${table} WHERE lon BETWEEN ${minLon} AND ${maxLon} AND lat BETWEEN ${minLat} AND ${maxLat};`,
  nearest: (table: string, column: string, lon: number, lat: number, k = 5) =>
    `SELECT ${column} AS geom, ST_Distance(${column}, ST_Point(${lon}, ${lat})) AS dist FROM ${table} ORDER BY dist LIMIT ${k};`,
};

export function createMockDuckDbClient(): DuckDbClient {
  const datasets = new Map<string, SpatialDataset>();
  return {
    async registerDataset(dataset) {
      datasets.set(dataset.id, dataset);
    },
    async unregisterDataset(id) {
      datasets.delete(id);
    },
    async query(query) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return makeResult(query.sql, query.format ?? "rows");
    },
    async queryGeoJson(_query): Promise<GeoJsonFeatureCollection> {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: { name: "北京站" }, geometry: { type: "Point", coordinates: [116.3913, 39.9075] } },
          { type: "Feature", properties: { name: "上海站" }, geometry: { type: "Point", coordinates: [121.4737, 31.2304] } },
        ],
      };
    },
  };
}
