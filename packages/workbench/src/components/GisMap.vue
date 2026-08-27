<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSourceSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { SAMPLE_FEATURES } from "@greywork/gis";

const props = withDefaults(
  defineProps<{
    layers?: { terrain: boolean; imagery: boolean; vector: boolean; live: boolean };
    active?: string | null;
  }>(),
  {
    layers: () => ({ terrain: true, imagery: true, vector: true, live: true }),
    active: null,
  },
);

const emit = defineEmits<{ select: [id: string]; hover: [id: string | null] }>();

const mapRef = ref<HTMLElement | null>(null);
const coordRef = ref("LON 000.000° · LAT 00.000°");
const mapBroken = ref(false);

let map: maplibregl.Map | null = null;
let observer: ResizeObserver | null = null;
let geojsonLoaded = false;
const pendingGeojson: { data: unknown; name: string }[] = [];

const citiesGeojson = {
  type: "FeatureCollection" as const,
  features: SAMPLE_FEATURES.map((f) => ({
    type: "Feature" as const,
    properties: { id: f.id, name: f.label },
    geometry: { type: "Point" as const, coordinates: [f.coordinate.lon, f.coordinate.lat] },
  })),
};

function backgroundFor(layers: typeof props.layers): string {
  if (layers.imagery) return "#0c1a2b";
  if (layers.terrain) return "#0a1520";
  return "#08101b";
}

function applyLayers() {
  if (!map) return;
  const bg = backgroundFor(props.layers);
  map.setPaintProperty("bg", "background-color", bg);
  const visible = props.layers.vector ? "visible" : "none";
  map.setLayoutProperty("cities-circles", "visibility", visible);
  map.setLayoutProperty("cities-labels", "visibility", visible);
  const color = props.layers.live ? "#61e3a5" : props.layers.vector ? "#3fd5e0" : "#31445f";
  map.setPaintProperty("cities-circles", "circle-color", color);
}

function applyActive() {
  if (!map || !geojsonLoaded) return;
  const activeId = props.active ?? "__none__";
  map.setPaintProperty("cities-circles", "circle-color", [
    "match",
    ["get", "id"],
    activeId,
    "#ffb85c",
    props.layers.live ? "#61e3a5" : "#3fd5e0",
  ]);
  map.setPaintProperty("cities-circles", "circle-stroke-width", ["match", ["get", "id"], activeId, 3, 1]);
}

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    return !!gl;
  } catch {
    return false;
  }
}

function addGeoJson(data: unknown, name = "导入数据") {
  if (!map || !geojsonLoaded) {
    pendingGeojson.push({ data, name });
    return;
  }
  const id = "import-" + Date.now();
  map.addSource(id, { type: "geojson", data } as GeoJSONSourceSpecification);
  map.addLayer({
    id: id + "-circles",
    type: "circle",
    source: id,
    paint: {
      "circle-radius": 8,
      "circle-color": "#ff9d7a",
      "circle-stroke-color": "#e8f0fa",
      "circle-stroke-width": 1,
    },
  });
  map.addLayer({
    id: id + "-labels",
    type: "symbol",
    source: id,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Open Sans Semibold"],
      "text-size": 12,
      "text-offset": [0, 1.4],
    },
    paint: { "text-color": "#ffd9b3", "text-halo-color": "#08101b", "text-halo-width": 2 },
  });
}

function flushPending() {
  for (const item of pendingGeojson.splice(0)) {
    addGeoJson(item.data, item.name);
  }
}

defineExpose({ addGeoJson });

function createMap() {
  if (!mapRef.value || map) return;
  if (!hasWebGL()) {
    mapBroken.value = true;
    return;
  }
  const style: maplibregl.StyleSpecification = {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {},
    layers: [{ id: "bg", type: "background", paint: { "background-color": backgroundFor(props.layers) } }],
  };

  try {
    map = new maplibregl.Map({
      container: mapRef.value,
      style,
      center: [104, 36],
      zoom: 1.6,
      attributionControl: false,
    });
  } catch {
    mapBroken.value = true;
    return;
  }

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");

  map.on("load", () => {
    if (!map) return;
    map.addSource("cities", {
      type: "geojson",
      data: citiesGeojson,
    });
    map.addLayer({
      id: "cities-circles",
      type: "circle",
      source: "cities",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 4, 6, 11],
        "circle-color": props.layers.live ? "#61e3a5" : "#3fd5e0",
        "circle-stroke-color": "#e8f0fa",
        "circle-stroke-width": 1,
      },
    });
    map.addLayer({
      id: "cities-labels",
      type: "symbol",
      source: "cities",
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Open Sans Semibold"],
        "text-size": 12,
        "text-offset": [0, 1.4],
      },
      paint: {
        "text-color": "#e8f0fa",
        "text-halo-color": "#08101b",
        "text-halo-width": 2,
      },
    });

    map.on("click", "cities-circles", (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (typeof id === "string") emit("select", id);
    });
    map.on("mousemove", "cities-circles", (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (typeof id === "string") emit("hover", id);
    });
    map.on("mouseleave", "cities-circles", () => emit("hover", null));
    map.on("mousemove", (e) => {
      const lngLat = e.lngLat;
      coordRef.value = "LON " + lngLat.lng.toFixed(3) + "° · LAT " + lngLat.lat.toFixed(3) + "°";
    });

    geojsonLoaded = true;
    applyLayers();
    applyActive();
    flushPending();
  });
}

watch(
  () => props.layers,
  () => applyLayers(),
  { deep: true },
);
watch(
  () => props.active,
  () => applyActive(),
);

onMounted(() => {
  createMap();
  observer = new ResizeObserver(() => map?.resize());
  if (mapRef.value) observer.observe(mapRef.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  map?.remove();
  map = null;
});
</script>

<template>
  <div ref="mapRef" class="gis-map">
    <div class="gis-map__corner gis-map__corner--tl">
      <span class="gis-map__dot"></span>
      MAPLIBRE · WORLD GRID
    </div>
    <div class="gis-map__corner gis-map__corner--tr">LIVE SYNC</div>
    <div class="gis-map__corner gis-map__corner--bl">OSM · WGS84</div>
    <div class="gis-map__corner gis-map__corner--br">{{ coordRef }}</div>
    <div v-if="mapBroken" class="gis-map__fallback">
      <span class="gis-map__fallback-icon"><Map class="size-6" /></span>
      <p>当前环境未启用 WebGL</p>
      <span>MapLibre 地图将自动在支持 WebGL 的浏览器中启动</span>
    </div>
  </div>
</template>

<style scoped>
.gis-map {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 380px;
  border-radius: 18px;
  overflow: hidden;
  border: 1px solid var(--line-2);
  background: #08101b;
}

.gis-map :deep(.maplibregl-map) {
  width: 100%;
  height: 100%;
}

.gis-map :deep(.maplibregl-ctrl-top-left) {
  margin: 12px;
}

.gis-map__corner {
  position: absolute;
  z-index: 4;
  font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: #6f8baa;
  text-transform: uppercase;
  pointer-events: none;
}

.gis-map__corner--tl {
  top: 14px;
  left: 16px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.gis-map__corner--tr {
  top: 14px;
  right: 16px;
  color: #61e3a5;
}

.gis-map__corner--bl {
  bottom: 14px;
  left: 16px;
}

.gis-map__corner--br {
  bottom: 14px;
  right: 16px;
  color: #f6bd7a;
}

.gis-map__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #3fd5e0;
  box-shadow: 0 0 12px #3fd5e0;
}

.gis-map__fallback {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: radial-gradient(45% 45% at 50% 45%, rgba(20, 36, 58, 0.5), transparent 72%), #08101b;
  color: #8fa6be;
  text-align: center;
}

.gis-map__fallback-icon {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  border: 1px solid #24405d;
  border-radius: 14px;
  color: #3fd5e0;
  font-size: 24px;
}

.gis-map__fallback p {
  margin: 8px 0 0;
  color: #d7e3f2;
  font-size: 13px;
  font-weight: 600;
}

.gis-map__fallback span {
  color: #56677f;
  font-size: 11px;
}
</style>
