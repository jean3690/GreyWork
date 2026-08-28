<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Map } from "lucide-vue-next";
import { createMapLibreMap, type MapLibreLayerState, type MapLibreMapHandle } from "@greywork/gis";

const props = withDefaults(
  defineProps<{
    layers?: MapLibreLayerState;
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

let handle: MapLibreMapHandle | null = null;

onMounted(() => {
  if (!mapRef.value) return;
  handle = createMapLibreMap({
    container: mapRef.value,
    layers: props.layers,
    active: props.active,
  });
  mapBroken.value = !handle.available;
  handle.onSelect((id) => emit("select", id));
  handle.onHover((id) => emit("hover", id));
  handle.onCoord((text) => (coordRef.value = text));
  handle.onBroken(() => (mapBroken.value = true));
});

onBeforeUnmount(() => {
  handle?.dispose();
  handle = null;
});

function addGeoJson(data: unknown, name?: string): void {
  handle?.addGeoJson(data, name);
}

watch(
  () => props.layers,
  (layers) => handle?.setLayers(layers),
  { deep: true },
);
watch(
  () => props.active,
  (active) => handle?.setActive(active),
);

defineExpose({ addGeoJson });
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
