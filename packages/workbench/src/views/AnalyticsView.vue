<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { SPATIAL_SQL_TEMPLATES, createMockDuckDbClient, type DuckDbClient } from "@greywork/analytics";
import { createSpatialDescriptor, describeSpatialData } from "@greywork/spatial";
import { DataTable, FilePick, Select, type TableColumn } from "../components/ui";

const spatialTile = createSpatialDescriptor("mbtiles", "terrain", "/data/terrain.mbtiles", { tileCount: 128 });
const spatialText = describeSpatialData(spatialTile);
const sqlSample = SPATIAL_SQL_TEMPLATES.nearest("stations", "geom", 116.3913, 39.9075, 8);

const duckDbStatus = ref("LOADING");
const duckDbRows = ref<string[][]>([]);
const uploadedData = ref<{ id: string; name: string; format: string }[]>([]);
let duckDbWasmClient: DuckDbClient | null = null;

const tableRows = [
  ["pt-001", "北京站", "116.3913", "39.9075", "1284"],
  ["pt-002", "上海站", "121.4737", "31.2304", "2231"],
  ["pt-003", "深圳站", "114.0579", "22.5431", "876"],
];

type ResultRow = { id: string; name: string; lon: string; lat: string; value: string };
const resultColumns: TableColumn[] = [
  { title: "id", key: "id" },
  { title: "name", key: "name" },
  { title: "lon", key: "lon" },
  { title: "lat", key: "lat" },
  { title: "value", key: "value" },
];

const resultRows = computed<ResultRow[]>(() => {
  const rows = duckDbRows.value.length ? duckDbRows.value : tableRows;
  return rows.map((row) => ({
    id: row[0],
    name: row[1],
    lon: row[2],
    lat: row[3],
    value: row[4],
  }));
});

const chartBars = [42, 68, 55, 88, 74, 96, 61, 83];

const activeDataset = ref("cities");
const datasetOptions = [
  { label: "cities · geojson", value: "cities" },
  { label: "terrain · mbtiles", value: "terrain" },
  { label: "stations · csv", value: "stations" },
];

function registerAndQueryUploaded(
  dataset: Parameters<DuckDbClient["registerDataset"]>[0],
  readerFunction: "read_csv_auto" | "read_parquet",
  fileName: string,
): void {
  void (async () => {
    try {
      if (!duckDbWasmClient) throw new Error("DuckDB not ready");
      await duckDbWasmClient.registerDataset(dataset);
      const result = await duckDbWasmClient.query({
        sql: "SELECT * FROM " + readerFunction + "('" + dataset.id + "') LIMIT 10",
      });
      duckDbRows.value = result.rows.map((row) => row.map(String));
      duckDbStatus.value = "REAL · " + fileName;
      uploadedData.value.push({ id: dataset.id, name: fileName, format: dataset.format });
    } catch (error) {
      duckDbStatus.value = "QUERY ERROR";
      console.error("DuckDB upload query failed", error);
    }
  })();
}

function onDataFile(file: File): void {
  if (!file) return;
  const isCsv = file.name.toLowerCase().endsWith(".csv");
  const isParquet = file.name.toLowerCase().endsWith(".parquet");
  if (!isCsv && !isParquet) return;
  const fileId = "upload-" + Date.now() + (isCsv ? ".csv" : ".parquet");

  if (isCsv) {
    const reader = new FileReader();
    reader.onload = () => {
      registerAndQueryUploaded(
        { id: fileId, name: file.name, format: "csv", path: file.name, content: String(reader.result ?? "") },
        "read_csv_auto",
        file.name,
      );
    };
    reader.readAsText(file);
  } else {
    const reader = new FileReader();
    reader.onload = () => {
      registerAndQueryUploaded(
        { id: fileId, name: file.name, format: "parquet", path: file.name, buffer: reader.result as ArrayBuffer },
        "read_parquet",
        file.name,
      );
    };
    reader.readAsArrayBuffer(file);
  }
}

onMounted(async () => {
  try {
    duckDbStatus.value = "INITIALIZING";
    // duckdb-wasm 体积敏感：经 @greywork/analytics/wasm 子路径动态加载，独立 chunk
    const { createDuckDbWasmClient } = await import("@greywork/analytics/wasm");
    duckDbWasmClient = await createDuckDbWasmClient();
    const result = await duckDbWasmClient.query({
      sql: "SELECT * FROM (VALUES ('pt-001','北京站',116.3913,39.9075,1284),('pt-002','上海站',121.4737,31.2304,2231),('pt-003','深圳站',114.0579,22.5431,876)) AS t(id,name,lon,lat,value)",
    });
    duckDbRows.value = result.rows.map((row) => row.map(String));
    duckDbStatus.value = "REAL · DUCKDB-WASM";
  } catch (error) {
    // README 宣称的 Mock 降级：wasm 初始化失败时切换内存 mock 客户端（上传查询仍可用）
    const fallback = createMockDuckDbClient();
    duckDbWasmClient = fallback;
    const mocked = await fallback.query({ sql: "SELECT * FROM cities", format: "rows" });
    duckDbRows.value = mocked.rows.map((row) => row.map(String));
    duckDbStatus.value = "MOCK FALLBACK";
    console.warn("DuckDB-WASM unavailable, falling back to mock", error);
  }
});
</script>

<template>
  <section class="view">
    <div class="view__head">
      <div>
        <p class="view__eyebrow">DUCKDB LAB</p>
        <h1 class="view__title">数据洞察</h1>
        <p class="view__sub">DuckDB-WASM 客户端空间 SQL 分析。</p>
      </div>
      <div class="view__actions"><button class="btn btn--ghost">数据集</button><button class="btn btn--primary">运行查询</button></div>
    </div>
    <div class="analytics-grid">
      <div class="panel">
        <div class="panel__head"><span class="panel__title">数据集</span><span class="panel__meta">REGISTER</span></div>
        <Select v-model="activeDataset" :options="datasetOptions" placeholder="选择数据集" trigger-class="h-8" />
        <div class="import-actions">
          <FilePick accept=".csv,.parquet" label="导入 CSV / Parquet" variant="default" @select="onDataFile" />
        </div>
        <ul v-if="uploadedData.length" class="source-list source-list--imported">
          <li v-for="d in uploadedData" :key="d.id" class="source">
            <span class="source__type">{{ d.format }}</span>
            <strong>{{ d.name }}</strong>
            <code>{{ d.id }}</code>
          </li>
        </ul>
        <p class="footnote">{{ spatialText }} · {{ duckDbStatus }}</p>
      </div>
      <div class="panel panel--query">
        <div class="panel__head">
          <span class="panel__title">SQL</span><span class="panel__meta">{{ duckDbStatus }}</span>
        </div>
        <pre class="sql"><code>{{ sqlSample }}</code></pre>
        <DataTable :columns="resultColumns" :data="resultRows" class="mt-3 text-xs" />
      </div>
      <div class="panel">
        <div class="panel__head"><span class="panel__title">聚合结果</span><span class="panel__meta">BAR</span></div>
        <div class="chart">
          <div v-for="(bar, i) in chartBars" :key="i" class="chart__col">
            <i class="chart__bar" :style="{ height: bar + '%' }"></i>
            <span>{{ i + 1 }}</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
