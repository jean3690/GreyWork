import * as duckdb from "@duckdb/duckdb-wasm";
import { assertSqlAllowed, type SqlRisk } from "./sql-risk";
import type { DuckDbClient, DuckDbSpatialQuery, GeoJsonFeatureCollection, QueryResult, SpatialDataset } from "./types";

/**
 * 真实 DuckDB-WASM 客户端（jsDelivr bundles 懒加载）。
 * 适用于浏览器 / Tauri WebView；不可用时上层会回退到 Mock。
 */
export async function createDuckDbWasmClient(): Promise<DuckDbClient> {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();

  const run = async (query: DuckDbSpatialQuery): Promise<QueryResult> => {
    // 执行前风险守卫：只读默认策略，写/DDL 需显式 allowWrite（借鉴 DBX sql_risk）。
    const risk: SqlRisk = assertSqlAllowed(query.sql, { allowWrite: query.allowWrite });
    const started = performance.now();
    const arrow = await conn.query(query.sql);
    const columns = arrow.schema.fields.map((field) => field.name);
    const rows: unknown[][] = arrow.toArray().map((row) => Array.from(row as unknown[]));
    return {
      columns,
      rows,
      rowCount: rows.length,
      durationMs: Math.round(performance.now() - started),
      format: query.format ?? "rows",
      // 守卫已保证 transaction/unknown 抛错，这里仅保留可执行风险等级供 UI 展示。
      risk: risk === "read-only" || risk === "write" || risk === "ddl" ? risk : undefined,
    };
  };

  return {
    async registerDataset(dataset: SpatialDataset) {
      if (dataset.content != null) {
        await db.registerFileText(dataset.id, dataset.content);
      } else if (dataset.buffer != null) {
        await db.registerFileBuffer(dataset.id, new Uint8Array(dataset.buffer));
      }
    },
    async unregisterDataset() {
      // no-op
    },
    async query(query) {
      return run(query);
    },
    async queryGeoJson(query): Promise<GeoJsonFeatureCollection> {
      const result = await run({ ...query, format: "geojson" });
      return {
        type: "FeatureCollection",
        features: result.rows.map((row) => ({
          type: "Feature",
          properties: { id: row[0], name: row[1] },
          geometry: { type: "Point", coordinates: [row[2], row[3]] },
        })),
      };
    },
  };
}
