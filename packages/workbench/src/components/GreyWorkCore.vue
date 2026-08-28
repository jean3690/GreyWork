<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { createCesiumGlobe, type CesiumGlobeHandle } from "@greywork/spatial";

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

let globe: CesiumGlobeHandle | null = null;

onMounted(() => {
  if (!rootRef.value) return;
  globe = createCesiumGlobe({ container: rootRef.value, mode: props.mode });
  webglBroken.value = !globe.available;
  globe.onSignal((signal) => (signalRef.value = signal));
  globe.onReadout((readout) => (readoutRef.value = readout));
});

onBeforeUnmount(() => {
  globe?.dispose();
  globe = null;
});

function addGeoJson(data: unknown, name?: string): void {
  globe?.addGeoJson(data, name);
}

async function load3dTiles(url: string): Promise<void> {
  await globe?.load3dTiles(url);
}

defineExpose({ addGeoJson, load3dTiles });
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
