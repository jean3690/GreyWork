// MapLibre 2D 地图渲染适配器（领域包侧）。
// 引擎按需懒加载：首次创建视图才拉取 chunk 与样式，避免领域包静态加载引擎
// 污染纯数学模块的 node 环境测试。
import type * as MaplibreNamespace from "maplibre-gl";
import { hasWebGL } from "@greywork/core";
import type { GeoFeature } from "./types";
import { SAMPLE_FEATURES } from "./layers";

/** 模块类型经命名空间派生，规避 import() 注解 lint 规则 */
type MaplibreModule = typeof MaplibreNamespace;

let maplibreModule: MaplibreModule | null = null;

/** 按需加载 MapLibre：动态 import 模块与样式。 */
async function loadMaplibre(): Promise<MaplibreModule> {
  if (!maplibreModule) {
    maplibreModule = await import("maplibre-gl");
    await import("maplibre-gl/dist/maplibre-gl.css");
  }
  return maplibreModule;
}

/** 由空间要素构造 FeatureCollection（MapLibre geojson 源数据）。 */
export function buildCitiesGeoJson(features: GeoFeature[]) {
  return {
    type: "FeatureCollection" as const,
    features: features.map((f) => ({
      type: "Feature" as const,
      properties: { id: f.id, name: f.label },
      geometry: { type: "Point" as const, coordinates: [f.coordinate.lon, f.coordinate.lat] },
    })),
  };
}

/** 可独立开关的地图层状态（与 GeoLayerKind 对齐） */
export interface MapLibreLayerState {
  terrain: boolean;
  imagery: boolean;
  vector: boolean;
  live: boolean;
}

export interface MapLibreMapOptions {
  /** 挂载容器；地图将占满容器。 */
  container: HTMLElement;
  layers?: MapLibreLayerState;
  active?: string | null;
  /** 初始点位要素；缺省使用内置 SAMPLE_FEATURES */
  features?: GeoFeature[];
}

export interface MapLibreMapHandle {
  /** WebGL 不可用 = false（UI 层据此切换降级占位） */
  available: boolean;
  /** 追加 GeoJSON 数据源（引擎未就绪时入队，load 后统一应用） */
  addGeoJson(data: unknown, name?: string): void;
  setLayers(layers: MapLibreLayerState): void;
  setActive(active: string | null): void;
  onSelect(listener: (id: string) => void): void;
  onHover(listener: (id: string | null) => void): void;
  /** 鼠标移动坐标读数 */
  onCoord(listener: (text: string) => void): void;
  /** 引擎加载/初始化失败（WebGL 探测通过但创建抛错） */
  onBroken(listener: () => void): void;
  dispose(): void;
}

/**
 * 创建 MapLibre 地图实例。WebGL 不可用时 available=false 并安全返回；
 * 初始化失败通过 onBroken 通知 UI 层切换占位。
 */
export function createMapLibreMap(options: MapLibreMapOptions): MapLibreMapHandle {
  const { container, features = SAMPLE_FEATURES } = options;
  const layerState: MapLibreLayerState = { terrain: true, imagery: true, vector: true, live: true, ...options.layers };
  let activeId: string | null = options.active ?? null;

  let map: MaplibreNamespace.Map | null = null;
  let geojsonLoaded = false;
  let disposed = false;
  const pendingGeojson: { data: unknown; name: string }[] = [];
  const selectListeners = new Set<(id: string) => void>();
  const hoverListeners = new Set<(id: string | null) => void>();
  const coordListeners = new Set<(text: string) => void>();
  const brokenListeners = new Set<() => void>();

  const citiesGeojson = buildCitiesGeoJson(features);

  function backgroundFor(layers: MapLibreLayerState): string {
    if (layers.imagery) return "#0c1a2b";
    if (layers.terrain) return "#0a1520";
    return "#08101b";
  }

  function applyLayers(): void {
    if (!map) return;
    map.setPaintProperty("bg", "background-color", backgroundFor(layerState));
    const visible = layerState.vector ? "visible" : "none";
    map.setLayoutProperty("cities-circles", "visibility", visible);
    map.setLayoutProperty("cities-labels", "visibility", visible);
    const color = layerState.live ? "#61e3a5" : layerState.vector ? "#3fd5e0" : "#31445f";
    map.setPaintProperty("cities-circles", "circle-color", color);
  }

  function applyActive(): void {
    if (!map || !geojsonLoaded) return;
    const id = activeId ?? "__none__";
    map.setPaintProperty("cities-circles", "circle-color", [
      "match",
      ["get", "id"],
      id,
      "#ffb85c",
      layerState.live ? "#61e3a5" : "#3fd5e0",
    ]);
    map.setPaintProperty("cities-circles", "circle-stroke-width", ["match", ["get", "id"], id, 3, 1]);
  }

  function addGeoJson(data: unknown, name = "导入数据"): void {
    if (!map || !geojsonLoaded) {
      pendingGeojson.push({ data, name });
      return;
    }
    const id = "import-" + Date.now();
    map.addSource(id, { type: "geojson", data } as MaplibreNamespace.GeoJSONSourceSpecification);
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

  function flushPending(): void {
    for (const item of pendingGeojson.splice(0)) {
      addGeoJson(item.data, item.name);
    }
  }

  async function init(): Promise<void> {
    if (disposed || !hasWebGL()) return;
    let mapInstance: MaplibreNamespace.Map | null = null;
    try {
      const maplibre = await loadMaplibre();
      if (disposed) return;
      mapInstance = new maplibre.Map({
        container,
        style: {
          version: 8,
          glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
          sources: {},
          layers: [{ id: "bg", type: "background", paint: { "background-color": backgroundFor(layerState) } }],
        },
        center: [104, 36],
        zoom: 1.6,
        attributionControl: false,
      });
      mapInstance.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-left");
    } catch (error) {
      console.error("[greywork/gis] MapLibre 初始化失败", error);
      brokenListeners.forEach((listener) => listener());
      return;
    }
    map = mapInstance;

    map.on("load", () => {
      if (!map || disposed) return;
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
          "circle-color": layerState.live ? "#61e3a5" : "#3fd5e0",
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
        if (typeof id === "string") selectListeners.forEach((listener) => listener(id));
      });
      map.on("mousemove", "cities-circles", (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (typeof id === "string") hoverListeners.forEach((listener) => listener(id));
      });
      map.on("mouseleave", "cities-circles", () => hoverListeners.forEach((listener) => listener(null)));
      map.on("mousemove", (e) => {
        const lngLat = e.lngLat;
        coordListeners.forEach((listener) => listener("LON " + lngLat.lng.toFixed(3) + "° · LAT " + lngLat.lat.toFixed(3) + "°"));
      });

      geojsonLoaded = true;
      applyLayers();
      applyActive();
      flushPending();
    });
  }

  const available = hasWebGL();
  if (available) void init();

  return {
    available,
    addGeoJson,
    setLayers(layers) {
      Object.assign(layerState, layers);
      applyLayers();
    },
    setActive(active) {
      activeId = active;
      applyActive();
    },
    onSelect(listener) {
      selectListeners.add(listener);
    },
    onHover(listener) {
      hoverListeners.add(listener);
    },
    onCoord(listener) {
      coordListeners.add(listener);
    },
    onBroken(listener) {
      brokenListeners.add(listener);
    },
    dispose() {
      disposed = true;
      map?.remove();
      map = null;
      selectListeners.clear();
      hoverListeners.clear();
      coordListeners.clear();
      brokenListeners.clear();
    },
  };
}
