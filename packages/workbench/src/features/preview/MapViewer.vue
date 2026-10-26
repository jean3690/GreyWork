<script setup lang="ts">
/**
 * GIS 预览：geojson / shp / kml / kmz / gpx / topojson 走 MapLibre GL。
 *
 * **刻意不挂底图**：本应用是自托管的、CSP 只放行同源，拉在线瓦片既要改 CSP 又要联网，
 * 而打开一个矢量文件想看的本来就是几何本身。空 style + 数据图层即可，也顺带没有
 * 任何外部请求。要底图是后续的事（自托管瓦片服务）。
 *
 * 数据按整份字节读（`fs_read_binary` 的 20MB 通道）：矢量数据超过这个体量本来也不适合
 * 在预览面板里铺开。shapefile 会顺带读同目录的 `.dbf`（属性）与 `.prj`（投影），
 * 读不到就降级 —— 没有属性也能画几何。
 *
 * **要素交互**（点击看属性 / 悬停高亮 / 缩放到要素）靠 MapLibre 的 feature-state：
 * source 必须开 `generateId`，要素 id 于是就是**数组下标** —— 面板、state 全按这个下标索引，
 * 而不是用 properties 里的业务 id（DBF 里通常没有，也不保证唯一）。
 *
 * 地图容器（`stage`）**不随加载态出现/消失**：`data` 的 watch 跑在 pre-flush 阶段，
 * 早于组件重渲染，若把容器放进 `v-else` 分支则建图时拿到的是 null（见 ModelViewer 里
 * 同一处说明）。只有「读取失败」才拆掉容器。
 */
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type GeoJSONSourceSpecification,
  type LayerSpecification,
  type MapGeoJSONFeature,
  type MapMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { combine, parseDbf, parseShp } from "shpjs";
import { extname } from "@greywork/core";
import Icon from "@/features/shared/Icon.vue";
import PreviewExternalButton from "@/features/preview/PreviewExternalButton.vue";
import { copyText } from "@/lib/clipboard";
import { kmzToKmlText, parseGpxText, parseKmlText, parseTopoJsonText } from "@/lib/gis-formats";
import { readPreviewBinary, usePreviewLoader } from "@/lib/preview-content";
import {
  boundsOfCollection,
  countByShape,
  isOutsideLonLat,
  parseGeoJsonText,
  pointOfGeometry,
  shapeOfGeometry,
  shapesOfCollection,
  unrenderableCount,
  type GeoJsonFeatureCollection,
  type GeoJsonShape,
  type LonLatBounds,
} from "@/lib/geojson";
import { readBinaryFile } from "@/state/workspaceFiles";
import { i18n } from "@/i18n";
import type { PreviewTab } from "@/stores/preview";

const props = defineProps<{
  tab: PreviewTab;
  /**
   * 由调用方解析好的集合（CSV 地图模式）。给了就不读文件 —— `.csv` 不是二进制 kind，
   * 走 `readPreviewBinary` 只会抛「不是二进制类型」。文件型 GIS 不传这个字段。
   */
  features?: GeoJsonFeatureCollection | null;
}>();

const t = i18n.global.t;

const EMPTY_BYTES = new Uint8Array();

/**
 * 文件通道仍然保留（并只在这里分派一次）：注入模式下用空字节占位，
 * 让 `usePreviewLoader` 的生命周期（loading / error / token）照常工作，但一次 IO 都不发。
 */
const { data, loading, error } = usePreviewLoader<Uint8Array>(toRef(props, "tab"), async (path) => {
  if (props.features) return EMPTY_BYTES;
  return readPreviewBinary(props.tab, path);
});

const stage = ref<HTMLElement | null>(null);
/** 解析 / 建图失败（与读取失败分开显示）。 */
const drawError = ref<string | null>(null);
const collection = ref<GeoJsonFeatureCollection | null>(null);

/** 选中要素（按 source 的要素下标）；null 表示没选中。 */
const selectedIndex = ref<number | null>(null);
/** 悬停要素下标。只用于描边/加粗，不参与面板。 */
const hoverIndex = ref<number | null>(null);
/** 指针位置的经纬度；移出地图置空。 */
const cursor = ref<{ lon: number; lat: number } | null>(null);
/** 被关掉的图层类别（点 / 线 / 面）。 */
const hiddenShapes = ref<ReadonlySet<GeoJsonShape>>(new Set());
/** shapefile 没读到 .prj：坐标系未知，需要提示。 */
const prjMissing = ref(false);

const SOURCE_ID = "gw-preview-data";
const SHAPES: readonly GeoJsonShape[] = ["point", "line", "polygon"];

const layerIdOf = (shape: GeoJsonShape): string => `${SOURCE_ID}-${shape}`;

/** feature-state 的布尔读数：paint 表达式里反复用到。 */
function stateFlag(key: "hover" | "selected"): unknown {
  return ["boolean", ["feature-state", key], false];
}

/**
 * 图层样式：一个要素集合里混着点/线/面是常态，所以按几何类型分三个图层，
 * 而不是按第一个要素决定画法。颜色写死（不读 CSS 变量）：MapLibre 的 paint
 * 需要具体色值，而这三个色在深浅两种主题下都够清晰。
 *
 * 选中 / 悬停走 feature-state 的三个表达式（颜色或尺寸），而不是另建高亮图层 ——
 * 高亮层要跟着过滤条件复制一遍，数据一换就容易漏。
 */
const LAYER_STYLE: Record<GeoJsonShape, { type: "circle" | "line" | "fill"; paint: Record<string, unknown> }> = {
  polygon: {
    type: "fill",
    paint: {
      "fill-color": ["case", stateFlag("selected"), "#f59e0b", "#3b82f6"],
      "fill-opacity": ["case", stateFlag("selected"), 0.55, ["case", stateFlag("hover"), 0.45, 0.35]],
      "fill-outline-color": ["case", stateFlag("selected"), "#b45309", "#1d4ed8"],
    },
  },
  line: {
    type: "line",
    paint: {
      "line-color": ["case", stateFlag("selected"), "#f59e0b", "#f97316"],
      "line-width": ["case", stateFlag("selected"), 3.2, ["case", stateFlag("hover"), 2.4, 1.5]],
    },
  },
  point: {
    type: "circle",
    paint: {
      "circle-color": ["case", stateFlag("selected"), "#f59e0b", "#ef4444"],
      "circle-radius": ["case", stateFlag("selected"), 6.5, ["case", stateFlag("hover"), 5, 3.5]],
      "circle-stroke-color": "#7f1d1d",
      "circle-stroke-width": 0.5,
    },
  },
};

const SHAPE_LABEL_KEY: Record<GeoJsonShape, string> = {
  point: "preview.gis.shapes.point",
  line: "preview.gis.shapes.line",
  polygon: "preview.gis.shapes.polygon",
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
  prjMissing.value = !prjBytes;
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

/**
 * 按扩展名分派解析器。
 *
 * 除 shp / kmz 这两个二进制容器外，其余都是文本（geojson / kml / gpx / topojson）——
 * 它们仍然走 `fs_read_binary`：分派是按 kind 做的（gis 统一按二进制读），
 * 这条通道对 XML 也完全适用，没必要为文本格式再开一条。
 */
async function toCollection(tab: PreviewTab, bytes: Uint8Array): Promise<GeoJsonFeatureCollection> {
  const ext = extname(tab.path).toLowerCase();
  if (ext === "shp") return shapefileToCollection(tab, bytes);
  if (ext === "kmz") return parseKmlText(await kmzToKmlText(bytes));
  const text = new TextDecoder().decode(bytes);
  if (ext === "kml") return parseKmlText(text);
  if (ext === "gpx") return parseGpxText(text);
  if (ext === "topojson") return parseTopoJsonText(text);
  return parseGeoJsonText(text);
}

/** 地图上已建的图层 id（数据里没有的类别不建层）。 */
function existingLayers(): string[] {
  const instance = map;
  if (!instance) return [];
  return SHAPES.map(layerIdOf).filter((id) => instance.getLayer(id) !== undefined);
}

/** 指针下的要素下标；命中的是最上层要素。 */
function featureIndexAt(point: MapMouseEvent["point"]): number | null {
  const instance = map;
  if (!instance) return null;
  const layers = existingLayers();
  if (layers.length === 0) return null;
  const [feature] = instance.queryRenderedFeatures(point, { layers }) as MapGeoJSONFeature[];
  // generateId 保证 id 就是数组下标；不是 number 说明拿到的不是我们的数据源。
  return typeof feature?.id === "number" ? feature.id : null;
}

function setHover(next: number | null): void {
  if (hoverIndex.value === next) return;
  const instance = map;
  if (instance) {
    if (hoverIndex.value !== null) instance.setFeatureState({ source: SOURCE_ID, id: hoverIndex.value }, { hover: false });
    if (next !== null) instance.setFeatureState({ source: SOURCE_ID, id: next }, { hover: true });
    instance.getCanvas().style.cursor = next === null ? "" : "pointer";
  }
  hoverIndex.value = next;
}

function select(next: number | null): void {
  const instance = map;
  if (instance) {
    if (selectedIndex.value !== null) instance.setFeatureState({ source: SOURCE_ID, id: selectedIndex.value }, { selected: false });
    if (next !== null) instance.setFeatureState({ source: SOURCE_ID, id: next }, { selected: true });
  }
  selectedIndex.value = next;
}

function onMapMove(event: MapMouseEvent): void {
  cursor.value = { lon: event.lngLat.lng, lat: event.lngLat.lat };
  setHover(featureIndexAt(event.point));
}

function onMapLeave(): void {
  cursor.value = null;
  setHover(null);
}

function onMapClick(event: MapMouseEvent): void {
  select(featureIndexAt(event.point));
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
  // 导航控件放左上：属性面板浮在右侧，放右上会被它盖住。
  map.addControl(new NavigationControl({ showCompass: false }), "top-left");
  map.addControl(new ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
  map.on("mousemove", onMapMove);
  map.on("mouseout", onMapLeave);
  map.on("click", onMapClick);
  return true;
}

/**
 * 跳到给定范围。投影坐标（UTM / 米）**跳过**：那些数字对 MapLibre 是无意义的经纬度，
 * fit 过去只会得到一片空白，看起来像渲染失败 —— 顶部提示条已经说明原因。
 */
function fitBoundsTo(bounds: LonLatBounds, options: { padding?: number; maxZoom?: number; duration?: number } = {}): void {
  if (!map || isOutsideLonLat(bounds)) return;
  map.fitBounds(
    [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[3]],
    ],
    // maxZoom 兜住「只有一个点」的情况：否则 fitBounds 会一路缩到最大级别。
    { padding: options.padding ?? 32, duration: options.duration ?? 0, maxZoom: options.maxZoom ?? 16 },
  );
}

function fitTo(next: GeoJsonFeatureCollection): void {
  const bounds = boundsOfCollection(next);
  if (bounds) fitBoundsTo(bounds);
}

/** 图层显隐跟着 hiddenShapes 走；新补的图层也要过一遍，否则开关对它们不生效。 */
function applyVisibility(): void {
  const instance = map;
  if (!instance) return;
  for (const shape of SHAPES) {
    const id = layerIdOf(shape);
    if (instance.getLayer(id) === undefined) continue;
    instance.setLayoutProperty(id, "visibility", hiddenShapes.value.has(shape) ? "none" : "visible");
  }
}

function paint(next: GeoJsonFeatureCollection): void {
  if (!map) return;
  const created = !map.getSource(SOURCE_ID);
  if (created) {
    // generateId：要素 id = 数组下标，交互按它对上号。
    map.addSource(SOURCE_ID, { type: "geojson", data: asMapData(next), generateId: true });
  } else {
    (map.getSource(SOURCE_ID) as GeoJSONSource).setData(asMapData(next));
    // 下标在新数据里指向别的要素：旧的高亮状态必须清掉，否则会高亮错的图形。
    map.removeFeatureState({ source: SOURCE_ID });
  }

  // 逐类建图层、已建过的跳过。产物就地更新时（revision 变而 tab 不变，实例不重建）
  // 同一个 map 会再画一次 —— 若这次多出一种几何而对应图层没补上，那部分会静默不显示。
  for (const shape of shapesOfCollection(next)) {
    const id = layerIdOf(shape);
    if (map.getLayer(id) !== undefined) continue;
    const style = LAYER_STYLE[shape];
    map.addLayer({
      id,
      type: style.type,
      source: SOURCE_ID,
      filter: ["==", ["geometry-type"], GEOMETRY_FILTER[shape]],
      paint: style.paint,
    } as LayerSpecification);
  }
  applyVisibility();
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

/** 换成一份新集合：清掉旧的选中/悬停下标，再画。 */
function show(next: GeoJsonFeatureCollection): void {
  drawError.value = null;
  // 内容换了，旧的选中/悬停下标不再指向同一个要素。
  select(null);
  setHover(null);
  draw(next);
}

async function load(bytes: Uint8Array): Promise<void> {
  prjMissing.value = false;
  try {
    show(await toCollection(props.tab, bytes));
  } catch (cause) {
    collection.value = null;
    drawError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

watch(data, (bytes) => {
  // 注入模式（CSV 地图）：data 只是占位空字节，别拿它去解析。
  if (props.features) return;
  if (!bytes) {
    collection.value = null;
    drawError.value = null;
    return;
  }
  void load(bytes);
});

/** 注入模式：集合来自调用方，解析/降级已在上游完成。 */
function showInjected(next: GeoJsonFeatureCollection): void {
  prjMissing.value = false;
  try {
    show(next);
  } catch (cause) {
    collection.value = null;
    drawError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

watch(
  () => props.features,
  (next) => {
    if (next) showInjected(next);
  },
);

// 注入值是同步就绪的，watch 的 immediate 会在 stage 绑定前跑（拿到 null 容器）；
// 首帧留给 onMounted。
onMounted(() => {
  if (props.features) showInjected(props.features);
});

onBeforeUnmount(() => {
  map?.remove();
  map = null;
});

const featureCount = computed(() => collection.value?.features.length ?? 0);
const shapeCounts = computed(() => (collection.value ? countByShape(collection.value) : null));
const visibleShapes = computed(() => (collection.value ? shapesOfCollection(collection.value) : []));

/** 提示条：空文件 / 画不出的要素 / 投影坐标 / 缺 .prj。 */
const notices = computed<{ key: string; text: string }[]>(() => {
  const next: { key: string; text: string }[] = [];
  const current = collection.value;
  if (!current) return next;
  if (current.features.length === 0) next.push({ key: "empty", text: t("preview.gis.empty") });
  const skipped = unrenderableCount(current);
  if (skipped > 0) next.push({ key: "skipped", text: t("preview.gis.skipped", { count: skipped }) });
  const bounds = boundsOfCollection(current);
  if (bounds && isOutsideLonLat(bounds)) next.push({ key: "projected", text: t("preview.gis.outsideLonLat") });
  if (prjMissing.value) next.push({ key: "prj", text: t("preview.gis.noPrj") });
  return next;
});

const selectedFeature = computed(() => {
  const index = selectedIndex.value;
  const current = collection.value;
  if (index === null || !current) return null;
  const feature = current.features[index];
  return feature ? { index, feature } : null;
});

const selectedShape = computed<GeoJsonShape | null>(() =>
  selectedFeature.value ? shapeOfGeometry(selectedFeature.value.feature.geometry) : null,
);

const propertyRows = computed<{ key: string; value: string }[]>(() => {
  const properties = selectedFeature.value?.feature.properties;
  if (!properties) return [];
  return Object.entries(properties).map(([key, value]) => ({ key, value: formatValue(value) }));
});

const selectedCoordinate = computed<[number, number] | null>(() => {
  const geometry = selectedFeature.value?.feature.geometry;
  return geometry ? pointOfGeometry(geometry) : null;
});

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const cursorText = computed(() => (cursor.value ? `${cursor.value.lon.toFixed(5)}, ${cursor.value.lat.toFixed(5)}` : null));

function toggleShape(shape: GeoJsonShape): void {
  const next = new Set(hiddenShapes.value);
  if (next.has(shape)) next.delete(shape);
  else next.add(shape);
  hiddenShapes.value = next;
  applyVisibility();
  // 把选中的图层关掉时，属性卡指向的是看不见的图形 —— 一起收起来。
  if (next.has(shape)) {
    if (selectedShape.value === shape) select(null);
    if (hoverIndex.value !== null && shapeOfGeometry(collection.value?.features[hoverIndex.value]?.geometry) === shape) setHover(null);
  }
}

function zoomToSelected(): void {
  const feature = selectedFeature.value;
  if (!feature) return;
  const bounds = boundsOfCollection({ type: "FeatureCollection", features: [feature.feature] });
  if (bounds) fitBoundsTo(bounds, { padding: 80, maxZoom: 16, duration: 300 });
}

async function copySelected(): Promise<void> {
  const properties = selectedFeature.value?.feature.properties;
  if (!properties) return;
  await copyText(JSON.stringify(properties, null, 2)).catch(() => undefined);
}

async function copyCursor(): Promise<void> {
  if (cursorText.value) await copyText(cursorText.value).catch(() => undefined);
}

const toolButtonClass =
  "grid h-6 shrink-0 cursor-pointer place-items-center rounded-[calc(6px*var(--gw-radius-scale))] px-2 text-[11px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan";
const shapeChitClass =
  "h-5 shrink-0 cursor-pointer rounded-[calc(4px*var(--gw-radius-scale))] border px-1.5 text-[10.5px] tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan";
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span class="min-w-0 flex-1 truncate">{{ props.tab.name }}</span>
      <button
        v-for="shape in visibleShapes"
        :key="shape"
        type="button"
        :data-testid="`gis-shape-${shape}`"
        :class="[
          shapeChitClass,
          hiddenShapes.has(shape)
            ? 'border-line bg-transparent text-dim2/60 line-through'
            : 'border-line bg-panel text-dim2 hover:text-foreground',
        ]"
        :aria-pressed="!hiddenShapes.has(shape)"
        :aria-label="t(hiddenShapes.has(shape) ? 'preview.gis.showShape' : 'preview.gis.hideShape', { shape: t(SHAPE_LABEL_KEY[shape]) })"
        @click="toggleShape(shape)"
      >
        {{ t(SHAPE_LABEL_KEY[shape]) }} {{ shapeCounts?.[shape] ?? 0 }}
      </button>
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
    <template v-else>
      <ul v-if="notices.length" class="shrink-0 border-b border-line bg-panel-2/60 px-3 py-1.5" data-testid="gis-notice">
        <li v-for="notice in notices" :key="notice.key" class="text-[11px] leading-relaxed text-dim">
          <span :data-testid="`gis-notice-${notice.key}`">{{ notice.text }}</span>
        </li>
      </ul>
      <div class="relative min-h-0 flex-1">
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
        <button
          v-if="cursorText"
          type="button"
          data-testid="gis-cursor"
          :title="t('preview.gis.cursorHint')"
          class="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-[calc(4px*var(--gw-radius-scale))] border border-line bg-panel/90 px-2 py-0.5 font-mono text-[10.5px] tabular-nums text-dim2 backdrop-blur transition-colors hover:text-foreground"
          @click="copyCursor"
        >
          {{ cursorText }}
        </button>
        <aside
          v-if="selectedFeature"
          data-testid="gis-feature-panel"
          class="absolute inset-y-2 right-2 z-10 flex w-60 max-w-[calc(100%_-_1rem)] flex-col overflow-hidden rounded-[calc(8px*var(--gw-radius-scale))] border border-line bg-panel/95 shadow-lg backdrop-blur"
        >
          <header class="flex shrink-0 items-center gap-2 border-b border-line px-2.5 py-1.5">
            <span class="min-w-0 flex-1 truncate text-[11.5px] font-medium text-foreground" data-testid="gis-feature-title">
              {{ t("preview.gis.selected", { index: selectedFeature.index + 1 }) }}
            </span>
            <span class="shrink-0 rounded-[calc(4px*var(--gw-radius-scale))] bg-panel-2 px-1.5 py-0.5 text-[10px] text-dim">
              {{ selectedShape ? t(SHAPE_LABEL_KEY[selectedShape]) : t("preview.gis.shapes.unknown") }}
            </span>
            <button
              type="button"
              data-testid="gis-feature-close"
              :aria-label="t('preview.gis.closePanel')"
              :class="toolButtonClass"
              @click="select(null)"
            >
              <Icon name="close" :size="11" />
            </button>
          </header>
          <div class="min-h-0 flex-1 overflow-auto px-2.5 py-1.5" data-testid="gis-feature-properties">
            <p v-if="!propertyRows.length && !selectedCoordinate" class="text-[11px] leading-relaxed text-dim2">
              {{ t("preview.gis.noProperties") }}
            </p>
            <template v-else>
              <div
                v-for="row in propertyRows"
                :key="row.key"
                class="grid grid-cols-[minmax(0,0.45fr)_minmax(0,0.55fr)] gap-x-2 px-0.5 py-0.5 text-[11px] odd:bg-panel-2/50"
              >
                <span class="truncate text-dim2" :title="row.key">{{ row.key }}</span>
                <span class="break-words text-foreground">{{ row.value }}</span>
              </div>
              <div
                v-if="selectedCoordinate"
                class="mt-1 grid grid-cols-[minmax(0,0.45fr)_minmax(0,0.55fr)] gap-x-2 border-t border-line px-0.5 pt-1 text-[11px]"
              >
                <span class="text-dim2">{{ t("preview.gis.longitude") }}</span>
                <span class="font-mono tabular-nums text-foreground">{{ selectedCoordinate[0].toFixed(5) }}</span>
                <span class="text-dim2">{{ t("preview.gis.latitude") }}</span>
                <span class="font-mono tabular-nums text-foreground">{{ selectedCoordinate[1].toFixed(5) }}</span>
              </div>
            </template>
          </div>
          <footer class="flex shrink-0 items-center gap-1.5 border-t border-line px-2 py-1.5">
            <button type="button" data-testid="gis-feature-zoom" :class="toolButtonClass" @click="zoomToSelected">
              {{ t("preview.gis.zoomToFeature") }}
            </button>
            <button v-if="propertyRows.length" type="button" data-testid="gis-feature-copy" :class="toolButtonClass" @click="copySelected">
              {{ t("preview.gis.copyProperties") }}
            </button>
          </footer>
        </aside>
      </div>
    </template>
  </div>
</template>
