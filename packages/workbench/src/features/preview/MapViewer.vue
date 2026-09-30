<script setup lang="ts">
/**
 * GIS 预览：geojson / shp 走 MapLibre GL。
 *
 * **刻意不挂底图**：本应用是自托管的、CSP 只放行同源，拉在线瓦片既要改 CSP 又要联网，
 * 而打开一个矢量文件想看的本来就是几何本身。空 style + 数据图层即可，也顺带没有
 * 任何外部请求。要底图是后续的事（自托管瓦片服务）。
 *
 * 数据按整份字节读（`fs_read_binary` 的 20MB 通道）：矢量数据超过这个体量本来也不适合
 * 在预览面板里铺开。shapefile 会顺带读同目录的 `.dbf`（属性）与 `.prj`（投影），
 * 读不到就降级 —— 没有属性也能画几何。
 *
 * 地图容器（`stage`）**不随加载态出现/消失**：`data` 的 watch 跑在 pre-flush 阶段，
 * 早于组件重渲染，若把容器放进 `v-else` 分支则建图时拿到的是 null（见 ModelViewer 里
 * 同一处说明）。只有「读取失败」才拆掉容器。
 */
import { computed, onBeforeUnmount, ref, toRef, watch } from "vue";
import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type GeoJSONSourceSpecification,
  type LayerSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { combine, parseDbf, parseShp } from "shpjs";
import { extname } from "@greywork/core";
import PreviewExternalButton from "@/features/preview/PreviewExternalButton.vue";
import { usePreviewBinary } from "@/lib/preview-content";
import { boundsOfCollection, parseGeoJsonText, shapesOfCollection, type GeoJsonFeatureCollection, type GeoJsonShape } from "@/lib/geojson";
import { readBinaryFile } from "@/state/workspaceFiles";
import { i18n } from "@/i18n";
import type { PreviewTab } from "@/stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const t = i18n.global.t;

const { data, loading, error } = usePreviewBinary(toRef(props, "tab"));

const stage = ref<HTMLElement | null>(null);
/** 解析 / 建图失败（与读取失败分开显示）。 */
const drawError = ref<string | null>(null);
const collection = ref<GeoJsonFeatureCollection | null>(null);

const SOURCE_ID = "gw-preview-data";

/**
 * 图层样式：一个要素集合里混着点/线/面是常态，所以按几何类型分三个图层，
 * 而不是按第一个要素决定画法。颜色写死（不读 CSS 变量）：MapLibre 的 paint
 * 需要具体色值，而这三个色在深浅两种主题下都够清晰。
 */
const LAYER_STYLE: Record<GeoJsonShape, { type: "circle" | "line" | "fill"; paint: Record<string, unknown> }> = {
  polygon: {
    type: "fill",
    paint: { "fill-color": "#3b82f6", "fill-opacity": 0.35, "fill-outline-color": "#1d4ed8" },
  },
  line: {
    type: "line",
    paint: { "line-color": "#f97316", "line-width": 1.5 },
  },
  point: {
    type: "circle",
    paint: { "circle-color": "#ef4444", "circle-radius": 3.5, "circle-stroke-color": "#7f1d1d", "circle-stroke-width": 0.5 },
  },
};

/** 几何类型过滤器值（`geometry-type` 对 Multi* 返回基础类型）。 */
const GEOMETRY_FILTER: Record<GeoJsonShape, string> = {
  polygon: "Polygon",
  line: "LineString",
  point: "Point",
};

let map: MapLibreMap | null = null;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * 交给 MapLibre 的数据载荷。
 *
 * 归一化后的集合在结构上就是 GeoJSON，但 MapLibre 的类型来自 `@types/geojson` 的
 * `Geometry` 联合，而我们的 `geometry` 是 `unknown`（来源是不可信的 JSON / shpjs，
 * 只做了 `type` 白名单校验，没有逐坐标校验）。断言收在这一处，调用点不必各自 cast。
 */
function asMapData(collection: GeoJsonFeatureCollection): GeoJSONSourceSpecification["data"] {
  return collection as unknown as GeoJSONSourceSpecification["data"];
}

/** 读同目录的附属文件；不存在或未授权都返回 null（降级，不阻断几何渲染）。 */
async function readSibling(path: string): Promise<Uint8Array | null> {
  try {
    return await readBinaryFile(path);
  } catch {
    return null;
  }
}

async function shapefileToCollection(tab: PreviewTab, bytes: Uint8Array): Promise<GeoJsonFeatureCollection> {
  // 只在磁盘来源下尝试读附属文件：VFS 里没有「同目录」这个概念。
  const base = tab.path.replace(/\.shp$/i, "");
  const fromDisk = tab.source === "disk";
  const prjBytes = fromDisk ? await readSibling(`${base}.prj`) : null;
  const prj = prjBytes ? new TextDecoder().decode(prjBytes) : false;
  const geometries = parseShp(toArrayBuffer(bytes), prj);
  if (geometries.length === 0) throw new Error("shapefile 里没有要素");
  const dbfBytes = fromDisk ? await readSibling(`${base}.dbf`) : null;
  if (!dbfBytes) {
    return {
      type: "FeatureCollection",
      features: geometries.map((geometry) => ({ type: "Feature", properties: null, geometry })),
    };
  }
  return combine([geometries, parseDbf(toArrayBuffer(dbfBytes))]);
}

async function toCollection(tab: PreviewTab, bytes: Uint8Array): Promise<GeoJsonFeatureCollection> {
  if (extname(tab.path).toLowerCase() === "shp") return shapefileToCollection(tab, bytes);
  return parseGeoJsonText(new TextDecoder().decode(bytes));
}

function ensureMap(): boolean {
  if (map) return true;
  const host = stage.value;
  if (!host) return false;
  try {
    map = new MapLibreMap({
      container: host,
      // 空 style：没有底图、没有外部请求，只画我们自己的数据图层。
      style: { version: 8, sources: {}, layers: [] },
      center: [0, 0],
      zoom: 1,
      attributionControl: false,
    });
  } catch (cause) {
    // 没有 WebGL（老显卡 / 驱动被禁）时给一句话，而不是白屏。
    drawError.value = cause instanceof Error ? cause.message : String(cause);
    return false;
  }
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
  return true;
}

function fitTo(next: GeoJsonFeatureCollection): void {
  const bounds = boundsOfCollection(next);
  if (!bounds || !map) return;
  map.fitBounds(
    [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[3]],
    ],
    // maxZoom 兜住「只有一个点」的情况：否则 fitBounds 会一路缩到最大级别。
    { padding: 32, duration: 0, maxZoom: 16 },
  );
}

function paint(next: GeoJsonFeatureCollection): void {
  if (!map) return;
  const created = !map.getSource(SOURCE_ID);
  if (created) map.addSource(SOURCE_ID, { type: "geojson", data: asMapData(next) });
  else (map.getSource(SOURCE_ID) as GeoJSONSource).setData(asMapData(next));

  // 逐类建图层、已建过的跳过。产物就地更新时（revision 变而 tab 不变，实例不重建）
  // 同一个 map 会再画一次 —— 若这次多出一种几何而对应图层没补上，那部分会静默不显示。
  for (const shape of shapesOfCollection(next)) {
    const id = `${SOURCE_ID}-${shape}`;
    if (map.getLayer(id)) continue;
    const style = LAYER_STYLE[shape];
    map.addLayer({
      id,
      type: style.type,
      source: SOURCE_ID,
      filter: ["==", ["geometry-type"], GEOMETRY_FILTER[shape]],
      paint: style.paint,
    } as LayerSpecification);
  }
  // 只在首次建 source 时自动 fit：产物刷新不该把用户已经缩放到的视野拽回去。
  if (created) fitTo(next);
}

function draw(next: GeoJsonFeatureCollection): void {
  collection.value = next;
  if (!ensureMap() || !map) return;
  if (map.isStyleLoaded()) paint(next);
  // style 还没就绪时 addSource 会抛；等 load 再画。
  else map.once("load", () => paint(next));
}

async function load(bytes: Uint8Array): Promise<void> {
  drawError.value = null;
  try {
    draw(await toCollection(props.tab, bytes));
  } catch (cause) {
    collection.value = null;
    drawError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

watch(data, (bytes) => {
  if (!bytes) {
    collection.value = null;
    drawError.value = null;
    return;
  }
  void load(bytes);
});

onBeforeUnmount(() => {
  map?.remove();
  map = null;
});

const featureCount = computed(() => collection.value?.features.length ?? 0);
const toolButtonClass =
  "grid h-6 shrink-0 cursor-pointer place-items-center rounded-[calc(6px*var(--gw-radius-scale))] px-2 text-[11px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan";
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span class="min-w-0 flex-1 truncate">{{ props.tab.name }}</span>
      <span v-if="collection" class="shrink-0 tabular-nums" data-testid="gis-stats">
        {{ t("preview.gis.features", { count: featureCount }) }}
      </span>
      <button v-if="collection" type="button" data-testid="gis-fit" :class="toolButtonClass" @click="fitTo(collection)">
        {{ t("preview.gis.fit") }}
      </button>
    </div>

    <div v-if="error" role="alert" class="flex flex-wrap items-center gap-2 px-4 py-3">
      <span class="text-[12px] text-orange">{{ t("preview.common.readFailed", { detail: error }) }}</span>
      <PreviewExternalButton :tab="tab" />
    </div>
    <div v-else class="relative min-h-0 flex-1">
      <div ref="stage" data-testid="gis-stage" class="absolute inset-0" />
      <p v-if="loading" class="pointer-events-none absolute inset-0 grid place-items-center bg-panel/80 px-4 text-[12px] text-dim2">
        {{ t("preview.common.loading") }}
      </p>
      <div
        v-if="drawError"
        role="alert"
        class="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-2 border-t border-line bg-panel/95 px-4 py-2"
      >
        <span class="min-w-0 flex-1 text-[11.5px] text-orange">{{ t("preview.gis.parseFailed", { detail: drawError }) }}</span>
        <PreviewExternalButton :tab="tab" />
      </div>
    </div>
  </div>
</template>
