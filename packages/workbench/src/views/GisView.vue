<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FilePick } from "../components/ui";
import GisMap from "../components/GisMap.vue";
import { getGreyWorkCore } from "../components/greyWorkCoreSingleton";
import { SAMPLE_FEATURES } from "@greywork/gis";

const { t } = useI18n();

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
        <h1 class="view__title">{{ t("gis.title") }}</h1>
        <p class="view__sub">{{ t("gis.sub") }}</p>
      </div>
      <div class="view__actions">
        <button class="btn btn--ghost">{{ t("gis.importData") }}</button
        ><button class="btn btn--primary">{{ t("gis.spatialQuery") }}</button>
      </div>
    </div>
    <div class="gis-grid">
      <div class="panel panel--narrow">
        <div class="panel__head">
          <span class="panel__title">{{ t("gis.layers") }}</span
          ><span class="panel__meta">4 LAYERS</span>
        </div>
        <div class="toggles">
          <label
            v-for="layer in [
              ['terrain', 'gis.layer.terrain'],
              ['imagery', 'gis.layer.imagery'],
              ['vector', 'gis.layer.vector'],
              ['live', 'gis.layer.live'],
            ]"
            :key="layer[0]"
            class="toggle"
          >
            <input v-model="layers[layer[0] as 'terrain' | 'imagery' | 'vector' | 'live']" type="checkbox" />
            <span class="toggle__box"></span>{{ t(layer[1]) }}
          </label>
        </div>
        <p class="footnote">{{ t("gis.clickFeature") }}</p>
        <FilePick accept=".geojson,.json" :label="t('gis.importGeoJson')" variant="default" @select="onGeoFile" />
      </div>
      <div class="panel panel--wide">
        <GisMap ref="gisMapRef" :layers="layers" :active="selectedFeature" @select="selectedFeature = $event" />
      </div>
      <div class="panel panel--narrow">
        <div class="panel__head">
          <span class="panel__title">{{ t("gis.features") }}</span
          ><span class="panel__meta">{{ SAMPLE_FEATURES.length }} POINTS</span>
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
        <p v-if="activeFeature" class="footnote">
          {{ t("gis.currentFeature", { label: activeFeature.label, height: activeFeature.height ?? "-" }) }}
        </p>
      </div>
    </div>
  </section>
</template>
