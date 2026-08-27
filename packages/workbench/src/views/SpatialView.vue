<script setup lang="ts">
import { ref } from "vue";
import { FilePick } from "../components/ui";
import { getGreyWorkCore, useSharedGreyWorkCore } from "../components/greyWorkCoreSingleton";
import { SAMPLE_LOCAL_SOURCES } from "@greywork/gis";
import { SUPPORTED_FORMATS, createSpatialDescriptor, describeSpatialData } from "@greywork/spatial";

const coreHostRef = ref<HTMLElement | null>(null);
useSharedGreyWorkCore(coreHostRef);

const spatialTile = createSpatialDescriptor("mbtiles", "terrain", "/data/terrain.mbtiles", { tileCount: 128 });
const spatialText = describeSpatialData(spatialTile);

const toggles = ref([
  { id: "grid", label: "经纬网格", on: true },
  { id: "points", label: "点云", on: true },
  { id: "orbits", label: "Agent 环", on: true },
  { id: "labels", label: "标注", on: true },
]);

const tilesUrl = ref("");
const importedDatasets = ref<{ id: string; name: string; format: string; url?: string }[]>([]);

function readGeoJsonFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result as string);
      const id = "ds-" + Date.now();
      importedDatasets.value.push({ id, name: file.name, format: "geojson" });
      getGreyWorkCore().addGeoJson(data, file.name);
    } catch (error) {
      console.error("GeoJSON parse failed", error);
    }
  };
  reader.readAsText(file);
}

function onGeoFile(file: File): void {
  readGeoJsonFile(file);
}

function loadTileset(): void {
  const url = tilesUrl.value.trim();
  if (!url) return;
  importedDatasets.value.push({ id: "tiles-" + Date.now(), name: "3D Tiles", format: "3dtiles", url });
  void getGreyWorkCore().load3dTiles(url);
  tilesUrl.value = "";
}
</script>

<template>
  <section class="view">
    <div class="view__head">
      <div>
        <p class="view__eyebrow">SPATIAL LAB</p>
        <h1 class="view__title">3D 空间</h1>
        <p class="view__sub">CesiumJS 数字地球与本地 3D Tiles 数据编排。</p>
      </div>
      <div class="view__actions"><button class="btn btn--ghost">切换瓦片集</button><button class="btn btn--primary">FlyTo</button></div>
    </div>
    <div class="spatial-grid">
      <div class="panel panel--narrow">
        <div class="panel__head"><span class="panel__title">图层控制</span><span class="panel__meta">LOCAL</span></div>
        <div class="toggles">
          <label v-for="t in toggles" :key="t.id" class="toggle">
            <input v-model="t.on" type="checkbox" />
            <span class="toggle__box"></span>{{ t.label }}
          </label>
        </div>
        <div class="chips">
          <span v-for="f in SUPPORTED_FORMATS" :key="f" class="chip">{{ f }}</span>
        </div>
        <p class="footnote">{{ spatialText }}</p>
      </div>
      <div class="panel panel--wide">
        <div ref="coreHostRef" class="gw-core-host gw-core-host--spatial"></div>
      </div>
      <div class="panel panel--narrow">
        <div class="panel__head"><span class="panel__title">数据源</span><span class="panel__meta">3 FILES</span></div>
        <ul class="source-list">
          <li v-for="s in SAMPLE_LOCAL_SOURCES" :key="s.id" class="source">
            <span class="source__type">{{ s.type }}</span>
            <strong>{{ s.name }}</strong>
            <code>{{ s.path }}</code>
          </li>
        </ul>
        <div class="import-actions">
          <FilePick accept=".geojson,.json" label="导入 GeoJSON" variant="default" @select="onGeoFile" />
        </div>
        <div class="tiles-url">
          <input v-model="tilesUrl" placeholder="3D Tiles URL (tileset.json)" @keydown.enter="loadTileset" />
          <button class="btn btn--mini" @click="loadTileset">加载</button>
        </div>
        <ul v-if="importedDatasets.length" class="source-list source-list--imported">
          <li v-for="ds in importedDatasets" :key="ds.id" class="source">
            <span class="source__type">{{ ds.format }}</span>
            <strong>{{ ds.name }}</strong>
            <code>{{ ds.url || "已同步至 Cesium / MapLibre" }}</code>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.gw-core-host--spatial {
  min-height: 520px;
}
</style>
