<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type * as CesiumNamespace from "cesium";

/** 模块类型经命名空间派生，规避 import() 注解 lint 规则 */
type CesiumModule = typeof CesiumNamespace;
let cesiumModule: CesiumModule | null = null;

/** 按需加载 Cesium：主包与首屏不携带，首次进入 3D 视图才拉取 chunk 与样式。 */
async function loadCesium(): Promise<CesiumModule> {
  if (!cesiumModule) {
    (window as unknown as { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = new URL("cesium/", document.baseURI).href;
    cesiumModule = await import("cesium");
    await import("cesium/Build/Cesium/Widgets/widgets.css");
  }
  return cesiumModule;
}

const props = withDefaults(
  defineProps<{
    mode?: "core" | "spatial";
    compact?: boolean;
  }>(),
  { mode: "core", compact: false },
);

const rootRef = ref<HTMLElement | null>(null);
const readoutRef = ref("LON 116.391° · LAT 39.908°");
const signalRef = ref("CESIUM GL · SPATIAL CORE");
const webglBroken = ref(false);

let viewer: CesiumNamespace.Viewer | null = null;
let observer: ResizeObserver | null = null;
let removeReadout: (() => void) | null = null;

const CITY_POINTS: { name: string; lon: number; lat: number; color: string }[] = [
  { name: "北京", lon: 116.3913, lat: 39.9075, color: "#3fd5e0" },
  { name: "上海", lon: 121.4737, lat: 31.2304, color: "#a08bff" },
  { name: "深圳", lon: 114.0579, lat: 22.5431, color: "#ffb85c" },
  { name: "纽约", lon: -74.006, lat: 40.7128, color: "#61e3a5" },
  { name: "柏林", lon: 13.405, lat: 52.52, color: "#3fd5e0" },
  { name: "新加坡", lon: 103.8198, lat: 1.3521, color: "#a08bff" },
  { name: "悉尼", lon: 151.2093, lat: -33.8688, color: "#ff9d7a" },
];

function makeCityGeoJson() {
  return {
    type: "FeatureCollection" as const,
    features: CITY_POINTS.map((p) => ({
      type: "Feature" as const,
      properties: { id: p.name, name: p.name },
      geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
    })),
  };
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

async function initViewer() {
  if (!rootRef.value || viewer) return;
  const Cesium = await loadCesium();
  const container = document.createElement("div");
  container.className = "gw-core__cesium";
  rootRef.value.appendChild(container);

  const creditContainer = document.createElement("div");
  creditContainer.style.display = "none";

  viewer = new Cesium.Viewer(container, {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    infoBox: false,
    selectionIndicator: false,
    fullscreenButton: false,
    creditContainer,
    baseLayer: new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })),
  });

  viewer.scene.globe.depthTestAgainstTerrain = false;
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = true;
  if (viewer.scene.moon) viewer.scene.moon.show = false;
  if (viewer.scene.sun) viewer.scene.sun.show = false;

  const dataSource = await Cesium.GeoJsonDataSource.load(makeCityGeoJson(), {
    stroke: Cesium.Color.fromCssColorString("#3fd5e0"),
    fill: Cesium.Color.fromCssColorString("#3fd5e0").withAlpha(0.28),
    strokeWidth: 2,
    markerSize: 14,
  });
  viewer.dataSources.add(dataSource);

  const ringColors = ["#ffb85c", "#3fd5e0", "#a08bff"];
  for (let i = 0; i < 18; i++) {
    const lon = Math.random() * 360 - 180;
    const lat = Math.random() * 160 - 80;
    const color = ringColors[i % 3];
    viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 2200000 + i * 180000),
      point: {
        pixelSize: 7,
        color: Cesium.Color.fromCssColorString(color),
        outlineColor: Cesium.Color.fromCssColorString("#0b1017"),
        outlineWidth: 1,
      },
      label: {
        text: "AGENT " + String(i + 1).padStart(2, "0"),
        font: "10px JetBrains Mono, monospace",
        fillColor: Cesium.Color.fromCssColorString("#8fa6be"),
        pixelOffset: new Cesium.Cartesian2(0, -13),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  const updateReadout = (): void => {
    if (!viewer) return;
    const pos = viewer.camera.positionCartographic;
    readoutRef.value =
      "LON " +
      Cesium.Math.toDegrees(pos.longitude).toFixed(1) +
      "° · LAT " +
      Cesium.Math.toDegrees(pos.latitude).toFixed(1) +
      "° · H " +
      Math.round(pos.height / 1000) +
      "km";
  };
  viewer.camera.moveEnd.addEventListener(updateReadout);
  removeReadout = () => viewer?.camera.moveEnd.removeEventListener(updateReadout);

  if (props.mode === "spatial") {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(116.39, 39.9, 3800000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-35), roll: 0 },
      duration: 1.6,
    });
  } else {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(104, 32, 26000000),
    });
  }
  signalRef.value = props.mode === "spatial" ? "CESIUM GL · 3D CITY MODE" : "CESIUM GL · GLOBAL MODE";
}

function addGeoJson(data: unknown, name = "导入数据") {
  if (!viewer) return;
  void loadCesium().then((Cesium) =>
    Cesium.GeoJsonDataSource.load(data as Parameters<CesiumModule["GeoJsonDataSource"]["load"]>[0], {
      stroke: Cesium.Color.fromCssColorString("#ffb85c"),
      fill: Cesium.Color.fromCssColorString("#ffb85c").withAlpha(0.24),
      strokeWidth: 2,
      markerSize: 14,
    }).then((ds) => {
      viewer?.dataSources.add(ds);
      signalRef.value = "GEOJSON ADDED · " + name;
    }),
  );
}

async function load3dTiles(url: string) {
  if (!viewer) return;
  const Cesium = await loadCesium();
  try {
    const tileset = await Cesium.Cesium3DTileset.fromUrl(url);
    viewer.zoomTo(tileset);
    signalRef.value = "3D TILES · LOADED";
  } catch (error) {
    signalRef.value = "3D TILES · FAILED";
    console.error(error);
  }
}

defineExpose({ addGeoJson, load3dTiles });

onMounted(async () => {
  if (!hasWebGL()) {
    webglBroken.value = true;
    signalRef.value = "WEBGL UNAVAILABLE · FALLBACK";
    return;
  }
  await initViewer();
  observer = new ResizeObserver(() => viewer?.resize());
  if (rootRef.value) observer.observe(rootRef.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  removeReadout?.();
  viewer?.destroy();
  viewer = null;
});
</script>

<template>
  <div ref="rootRef" class="gw-core" :class="{ compact: props.compact, spatial: props.mode === 'spatial' }">
    <div class="gw-core__corner gw-core__corner--tl">
      <span class="gw-core__dot"></span>
      GREYWORK CORE
      <em>cesium</em>
    </div>
    <div class="gw-core__corner gw-core__corner--tr">{{ signalRef }}</div>
    <div class="gw-core__corner gw-core__corner--bl">OSM · WGS84 · 3D TILES READY</div>
    <div class="gw-core__corner gw-core__corner--br">{{ readoutRef }}</div>
    <div v-if="mode === 'spatial'" class="gw-core__hint">Cesium 数字地球 · 拖拽/滚轮缩放 · 双击定位</div>

    <div v-if="webglBroken" class="gw-core__fallback">
      <div class="fallback-globe">
        <i class="fallback-orbit fallback-orbit--a"></i>
        <i class="fallback-orbit fallback-orbit--b"></i>
        <i class="fallback-dot"></i>
      </div>
      <p>当前环境未启用 WebGL</p>
      <span>CesiumJS 数字地球将自动在支持 WebGL 的浏览器中启动</span>
    </div>
  </div>
</template>

<style scoped>
.gw-core {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 320px;
  overflow: hidden;
  border-radius: 18px;
  background: #08111d;
  border: 1px solid var(--line-2);
}

.gw-core.spatial {
  min-height: 520px;
}

.gw-core :deep(.gw-core__cesium) {
  position: absolute;
  inset: 0;
}

.gw-core :deep(.cesium-viewer),
.gw-core :deep(.cesium-viewer-cesiumWidgetContainer),
.gw-core :deep(.cesium-widget),
.gw-core :deep(.cesium-widget canvas) {
  width: 100%;
  height: 100%;
}

.gw-core__corner {
  position: absolute;
  z-index: 5;
  font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: #6f8baa;
  text-transform: uppercase;
  pointer-events: none;
  user-select: none;
}

.gw-core__corner--tl {
  top: 14px;
  left: 16px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.gw-core__corner--tl em {
  font-style: normal;
  color: #465c7a;
}

.gw-core__corner--tr {
  top: 14px;
  right: 16px;
  color: #61e3a5;
}

.gw-core__corner--bl {
  bottom: 14px;
  left: 16px;
}

.gw-core__corner--br {
  bottom: 14px;
  right: 16px;
  color: #f6bd7a;
}

.gw-core__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #3fd5e0;
  box-shadow: 0 0 12px #3fd5e0;
}

.gw-core__hint {
  position: absolute;
  bottom: 42px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 6;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid #24405d;
  background: rgba(10, 19, 31, 0.8);
  color: #8fa6be;
  font-size: 11px;
  letter-spacing: 0.06em;
  white-space: nowrap;
}

.gw-core__fallback {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: radial-gradient(50% 40% at 50% 46%, rgba(20, 36, 58, 0.6), transparent 70%), #0a1018;
  color: #8fa6be;
  text-align: center;
}

.gw-core__fallback p {
  margin: 10px 0 0;
  color: #d7e3f2;
  font-size: 13px;
  font-weight: 600;
}

.gw-core__fallback span {
  color: #56677f;
  font-size: 11px;
}

.fallback-globe {
  position: relative;
  width: 120px;
  height: 120px;
  border: 1px solid rgba(63, 213, 224, 0.35);
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, rgba(63, 213, 224, 0.16), transparent 60%);
}

.fallback-orbit {
  position: absolute;
  inset: -18px;
  border: 1px solid rgba(160, 139, 255, 0.35);
  border-radius: 50%;
  transform: rotate(-18deg) scaleY(0.44);
}

.fallback-orbit--b {
  inset: -34px;
  border-color: rgba(255, 184, 92, 0.3);
  transform: rotate(28deg) scaleY(0.4);
}

.fallback-dot {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 10px;
  height: 10px;
  margin: -5px;
  border-radius: 50%;
  background: #ffb85c;
  box-shadow: 0 0 16px #ffb85c;
}
</style>
