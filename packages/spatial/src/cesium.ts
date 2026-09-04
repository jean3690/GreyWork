// CesiumJS 数字地球渲染适配器（领域包侧）。
// 引擎按需懒加载：主包与首屏不携带，首次创建视图才拉取 chunk 与样式。
// workbench 等 UI 层只负责容器 DOM 与降级占位，渲染逻辑在此封装。
import type * as CesiumNamespace from "cesium";
import { hasWebGL } from "@greywork/core";
import { buildCitiesGeoJson, SAMPLE_FEATURES } from "@greywork/gis";

/** 模块类型经命名空间派生，规避 import() 注解 lint 规则 */
type CesiumModule = typeof CesiumNamespace;

let cesiumModule: CesiumModule | null = null;

/** 按需加载 Cesium：设置 BASE_URL 后动态 import 模块与样式。 */
async function loadCesium(): Promise<CesiumModule> {
  if (!cesiumModule) {
    (window as unknown as { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = new URL("cesium/", document.baseURI).href;
    cesiumModule = await import("cesium");
    await import("cesium/Build/Cesium/Widgets/widgets.css");
  }
  return cesiumModule;
}

/** 数字地球示例城市点：与 @greywork/gis 的 SAMPLE_FEATURES 同源派生，避免双份示例数据。 */
export function buildCityGeoJson() {
  return buildCitiesGeoJson(SAMPLE_FEATURES);
}

export interface CesiumGlobeOptions {
  /** 挂载容器；Viewer 将占满容器。 */
  container: HTMLElement;
  /** core = 全球视角；spatial = 飞向北京上空 3D 城市视角 */
  mode?: "core" | "spatial";
}

export interface CesiumGlobeHandle {
  /** WebGL 不可用或初始化失败 = false（UI 层据此切换降级占位） */
  available: boolean;
  /** 追加 GeoJSON 数据源 */
  addGeoJson(data: unknown, name?: string): void;
  /** 加载 3D Tiles（tileset.json URL） */
  load3dTiles(url: string): Promise<void>;
  /** 状态信号（加载成功 / 失败 / 数据已加入） */
  onSignal(listener: (signal: string) => void): void;
  /** 相机位置读数（LON/LAT/H） */
  onReadout(listener: (readout: string) => void): void;
  dispose(): void;
}

/**
 * 创建 CesiumJS 数字地球实例。引擎懒加载，WebGL 不可用时 available=false 并安全返回。
 */
export function createCesiumGlobe(options: CesiumGlobeOptions): CesiumGlobeHandle {
  const { container, mode = "core" } = options;

  let viewer: CesiumNamespace.Viewer | null = null;
  let observer: ResizeObserver | null = null;
  let resizeFrame = 0;
  let removeReadout: (() => void) | null = null;
  const signalListeners = new Set<(signal: string) => void>();
  const readoutListeners = new Set<(readout: string) => void>();

  const emitSignal = (signal: string): void => signalListeners.forEach((listener) => listener(signal));
  const emitReadout = (readout: string): void => readoutListeners.forEach((listener) => listener(readout));

  async function initViewer(): Promise<void> {
    if (viewer) return;
    const Cesium = await loadCesium();
    const el = document.createElement("div");
    el.className = "gw-core__cesium";
    container.appendChild(el);

    const creditContainer = document.createElement("div");
    creditContainer.style.display = "none";

    viewer = new Cesium.Viewer(el, {
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

    const dataSource = await Cesium.GeoJsonDataSource.load(buildCityGeoJson(), {
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
      emitReadout(
        "LON " +
          Cesium.Math.toDegrees(pos.longitude).toFixed(1) +
          "° · LAT " +
          Cesium.Math.toDegrees(pos.latitude).toFixed(1) +
          "° · H " +
          Math.round(pos.height / 1000) +
          "km",
      );
    };
    viewer.camera.moveEnd.addEventListener(updateReadout);
    removeReadout = () => viewer?.camera.moveEnd.removeEventListener(updateReadout);

    if (mode === "spatial") {
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
    emitSignal(mode === "spatial" ? "CESIUM GL · 3D CITY MODE" : "CESIUM GL · GLOBAL MODE");
  }

  const available = hasWebGL();

  if (available) {
    void initViewer().catch((error) => {
      // 引擎加载或初始化失败：通知 UI 层保持占位，viewer 留空。
      console.error("[greywork/spatial] Cesium 初始化失败", error);
      emitSignal("CESIUM INIT · FAILED");
    });
    // 拖动窗口会高频触发 resize：rAF 节流，避免每帧同步 viewer.resize()。
    observer = new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        viewer?.resize();
      });
    });
    observer.observe(container);
  }

  return {
    available,
    addGeoJson(data: unknown, name = "导入数据") {
      if (!viewer) return;
      void loadCesium().then((Cesium) =>
        Cesium.GeoJsonDataSource.load(data as Parameters<CesiumModule["GeoJsonDataSource"]["load"]>[0], {
          stroke: Cesium.Color.fromCssColorString("#ffb85c"),
          fill: Cesium.Color.fromCssColorString("#ffb85c").withAlpha(0.24),
          strokeWidth: 2,
          markerSize: 14,
        }).then((ds) => {
          viewer?.dataSources.add(ds);
          emitSignal("GEOJSON ADDED · " + name);
        }),
      );
    },
    async load3dTiles(url: string) {
      if (!viewer) return;
      const Cesium = await loadCesium();
      try {
        const tileset = await Cesium.Cesium3DTileset.fromUrl(url);
        viewer.zoomTo(tileset);
        emitSignal("3D TILES · LOADED");
      } catch (error) {
        emitSignal("3D TILES · FAILED");
        console.error(error);
      }
    },
    onSignal(listener) {
      signalListeners.add(listener);
    },
    onReadout(listener) {
      readoutListeners.add(listener);
    },
    dispose() {
      if (resizeFrame) {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = 0;
      }
      observer?.disconnect();
      observer = null;
      removeReadout?.();
      removeReadout = null;
      viewer?.destroy();
      viewer = null;
      signalListeners.clear();
      readoutListeners.clear();
    },
  };
}

/**
 * 空闲预加载 Cesium 引擎（外壳首屏空闲时调用）。
 * 命中模块级缓存，不重复下载；仅预热，不创建 viewer。
 */
export function preloadCesiumEngine(): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") return Promise.resolve();
  return loadCesium().then(() => undefined);
}
