export type DataFormat = "geojson" | "mbtiles" | "3dtiles" | "parquet" | "csv";

export interface SpatialDataset {
  id: string;
  name: string;
  format: DataFormat;
  path: string;
  crs?: string;
  /** 预估要素/瓦片数量 */
  estimate?: number;
  /** CSV 文本内容（浏览器上传场景） */
  content?: string;
  /** Parquet 二进制内容（浏览器上传场景） */
  buffer?: ArrayBuffer;
}

export type QueryResultFormat = "rows" | "geojson" | "arrow";

export interface DuckDbSpatialQuery {
  sql: string;
  params?: Record<string, unknown>;
  format?: QueryResultFormat;
  limit?: number;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  durationMs: number;
  format: QueryResultFormat;
  truncated?: boolean;
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: unknown[];
}

export interface DuckDbClient {
  registerDataset(dataset: SpatialDataset): Promise<void>;
  unregisterDataset(id: string): Promise<void>;
  query(query: DuckDbSpatialQuery): Promise<QueryResult>;
  queryGeoJson(query: DuckDbSpatialQuery): Promise<GeoJsonFeatureCollection>;
}
