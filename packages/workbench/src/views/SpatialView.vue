<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { FilePick } from "../components/ui";
import { getGreyWorkCore, useSharedGreyWorkCore } from "../components/greyWorkCoreSingleton";
import { SAMPLE_LOCAL_SOURCES } from "@greywork/gis";
import { SUPPORTED_FORMATS, createSpatialDescriptor, describeSpatialData } from "@greywork/spatial";

const { t } = useI18n();

const coreHostRef = ref<HTMLElement | null>(null);
useSharedGreyWorkCore(coreHostRef);

const spatialTile = createSpatialDescriptor("mbtiles", "terrain", "/data/terrain.mbtiles", { tileCount: 128 });
const spatialText = describeSpatialData(spatialTile);

const toggles = ref([
  { id: "grid", label: "spatial.toggle.grid", on: true },
  { id: "points", label: "spatial.toggle.points", on: true },
  { id: "orbits", label: "spatial.toggle.orbits", on: true },
  { id: "labels", label: "spatial.toggle.labels", on: true },
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
        <h1 class="view__title">{{ t("spatial.title") }}</h1>
        <p class="view__sub">{{ t("spatial.sub") }}</p>
      </div>
      <div class="view__actions">
        <button class="btn btn--ghost">{{ t("spatial.switchTileset") }}</button><button class="btn btn--primary">FlyTo</button>
      </div>
    </div>
    <div class="spatial-grid">
      <div class="panel panel--narrow">
        <div class="panel__head">
          <span class="panel__title">{{ t("spatial.layerControl") }}</span
          ><span class="panel__meta">LOCAL</span>
        </div>
        <div class="toggles">
          <label v-for="toggle in toggles" :key="toggle.id" class="toggle">
            <input v-model="toggle.on" type="checkbox" />
            <span class="toggle__box"></span>{{ t(toggle.label) }}
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
        <div class="panel__head">
          <span class="panel__title">{{ t("spatial.dataSources") }}</span
          ><span class="panel__meta">3 FILES</span>
        </div>
        <ul class="source-list">
          <li v-for="s in SAMPLE_LOCAL_SOURCES" :key="s.id" class="source">
            <span class="source__type">{{ s.type }}</span>
            <strong>{{ s.name }}</strong>
            <code>{{ s.path }}</code>
          </li>
        </ul>
        <div class="import-actions">
          <FilePick accept=".geojson,.json" :label="t('spatial.importGeoJson')" variant="default" @select="onGeoFile" />
        </div>
        <div class="tiles-url">
          <input v-model="tilesUrl" placeholder="3D Tiles URL (tileset.json)" @keydown.enter="loadTileset" />
          <button class="btn btn--mini" @click="loadTileset">{{ t("spatial.load") }}</button>
        </div>
        <ul v-if="importedDatasets.length" class="source-list source-list--imported">
          <li v-for="ds in importedDatasets" :key="ds.id" class="source">
            <span class="source__type">{{ ds.format }}</span>
            <strong>{{ ds.name }}</strong>
            <code>{{ ds.url || t("spatial.synced") }}</code>
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
