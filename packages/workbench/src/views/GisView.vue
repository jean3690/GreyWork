<script setup lang="ts">
import { computed, ref } from "vue";
import { FilePick } from "../components/ui";
import GisMap from "../components/GisMap.vue";
import { getGreyWorkCore } from "../components/greyWorkCoreSingleton";
import { SAMPLE_FEATURES } from "@greywork/gis";

const layers = ref({ terrain: true, imagery: true, vector: true, live: true });
const selectedFeature = ref<string | null>(SAMPLE_FEATURES[0]?.id ?? null);
const gisMapRef = ref<InstanceType<typeof GisMap> | null>(null);

const activeFeature = computed(() => SAMPLE_FEATURES.find((f) => f.id === selectedFeature.value));

function readGeoJsonFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result as string);
      gisMapRef.value?.addGeoJson(data, file.name);
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
</script>

<template>
  <section class="view">
    <div class="view__head">
      <div>
        <p class="view__eyebrow">GEO CANVAS</p>
        <h1 class="view__title">GIS 地图</h1>
        <p class="view__sub">MapLibre 点阵世界地图与本地空间数据源。</p>
      </div>
      <div class="view__actions"><button class="btn btn--ghost">导入数据</button><button class="btn btn--primary">空间查询</button></div>
    </div>
    <div class="gis-grid">
      <div class="panel panel--narrow">
        <div class="panel__head"><span class="panel__title">图层</span><span class="panel__meta">4 LAYERS</span></div>
        <div class="toggles">
          <label
            v-for="t in [
              ['terrain', '地形'],
              ['imagery', '影像'],
              ['vector', '矢量'],
              ['live', '实时态势'],
            ]"
            :key="t[0]"
            class="toggle"
          >
            <input v-model="layers[t[0] as 'terrain' | 'imagery' | 'vector' | 'live']" type="checkbox" />
            <span class="toggle__box"></span>{{ t[1] }}
          </label>
        </div>
        <p class="footnote">点击地图标记查看要素详情。</p>
        <FilePick accept=".geojson,.json" label="导入 GeoJSON" variant="default" @select="onGeoFile" />
      </div>
      <div class="panel panel--wide">
        <GisMap ref="gisMapRef" :layers="layers" :active="selectedFeature" @select="selectedFeature = $event" />
      </div>
      <div class="panel panel--narrow">
        <div class="panel__head">
          <span class="panel__title">要素</span><span class="panel__meta">{{ SAMPLE_FEATURES.length }} POINTS</span>
        </div>
        <ul class="feature-list">
          <li
            v-for="f in SAMPLE_FEATURES"
            :key="f.id"
            class="feature"
            :class="{ active: selectedFeature === f.id }"
            @click="selectedFeature = f.id"
          >
            <span class="feature__dot" :data-layer="f.layer"></span>
            <span class="feature__label">{{ f.label }}</span>
            <code>{{ f.coordinate.lon.toFixed(3) }}, {{ f.coordinate.lat.toFixed(3) }}</code>
          </li>
        </ul>
        <p v-if="activeFeature" class="footnote">当前：{{ activeFeature.label }} · 高 {{ activeFeature.height ?? "-" }}m</p>
      </div>
    </div>
  </section>
</template>
