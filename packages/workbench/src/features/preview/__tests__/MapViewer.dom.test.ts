/**
 * GIS 预览（MapViewer）：硬契约。
 *
 * 1. 按整份字节读（`fs_read_binary` 的 20MB 通道）—— GIS 不是媒体 kind；
 * 2. 要素按几何类型分成点/线/面三个图层，而不是按第一个要素决定画法；
 * 3. 视野按数据包围盒自动 fit，且**不挂底图**（空 style，没有任何外部请求）；
 * 4. 解析失败给可见错误条，卸载要 `map.remove()`；
 * 5. 点击 / 悬停按要素下标（source 的 generateId）对号，面板读的是原始集合里的那一条；
 * 6. 投影坐标（米）既不自动 fit，也要给提示 —— 否则视野会被带到无意义的空白区。
 *
 * MapLibre 被 mock：happy-dom 没有 WebGL，这里验的是数据流与生命周期。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import type { GeoJsonFeatureCollection } from "@/lib/geojson";
import type { PreviewTab } from "@/stores/preview";

const h = vi.hoisted(() => ({
  readBinaryFile: vi.fn<(path: string) => Promise<Uint8Array>>(),
  readTextFile: vi.fn<(path: string) => Promise<string>>(),
  hasHostCommands: vi.fn<() => boolean>(),
  addSource: vi.fn<(id: string, spec: unknown) => void>(),
  addLayer: vi.fn<(layer: unknown) => void>(),
  setData: vi.fn<(data: unknown) => void>(),
  fitBounds: vi.fn<(bounds: unknown, options: unknown) => void>(),
  setFeatureState: vi.fn<(target: unknown, state: unknown) => void>(),
  removeFeatureState: vi.fn<(target: unknown) => void>(),
  setLayoutProperty: vi.fn<(id: string, property: string, value: unknown) => void>(),
  removed: vi.fn(),
  handlers: new Map<string, (event: unknown) => void>(),
  queryResult: [] as unknown[],
  styleLoaded: true,
}));

vi.mock("@/stores/vfs", () => ({ useVfsStore: () => ({ readBinary: vi.fn(), readFile: vi.fn() }) }));
vi.mock("@/state/workspaceFiles", () => ({
  readBinaryFile: h.readBinaryFile,
  readTextFile: h.readTextFile,
  readMediaFile: vi.fn(),
}));
vi.mock("@greywork/host-ipc", () => ({
  hasHostCommands: h.hasHostCommands,
  hasNativeShell: () => h.hasHostCommands(),
  mediaStreamUrl: () => null,
  // 测试 setup 会 setFront() 声明全量前端；这里只把身份落库，无需断言。
  declareFront: () => undefined,
}));

vi.mock("maplibre-gl", () => {
  class MapLibreMap {
    private sources = new Map<string, { setData: (data: unknown) => void }>();
    private layers = new Set<string>();
    addControl() {}
    getSource(id: string) {
      return this.sources.get(id);
    }
    addSource(id: string, spec: unknown) {
      this.sources.set(id, { setData: h.setData });
      h.addSource(id, spec);
    }
    getLayer(id: string) {
      return this.layers.has(id) ? { id } : undefined;
    }
    addLayer(layer: unknown) {
      this.layers.add((layer as { id: string }).id);
      h.addLayer(layer);
    }
    isStyleLoaded() {
      return h.styleLoaded;
    }
    once(_event: string, callback: () => void) {
      callback();
    }
    fitBounds(bounds: unknown, options: unknown) {
      h.fitBounds(bounds, options);
    }
    on(event: string, handler: (event: unknown) => void) {
      h.handlers.set(event, handler);
    }
    getCanvas() {
      return { style: {} as { cursor?: string } };
    }
    queryRenderedFeatures() {
      return h.queryResult;
    }
    setFeatureState(target: unknown, state: unknown) {
      h.setFeatureState(target, state);
    }
    removeFeatureState(target: unknown) {
      h.removeFeatureState(target);
    }
    setLayoutProperty(id: string, property: string, value: unknown) {
      h.setLayoutProperty(id, property, value);
    }
    remove() {
      h.removed();
    }
  }
  return { Map: MapLibreMap, NavigationControl: class {}, ScaleControl: class {}, GeoJSONSource: class {} };
});

import MapViewer from "@/features/preview/MapViewer.vue";

const GEOJSON = JSON.stringify({
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { name: "a" }, geometry: { type: "Point", coordinates: [116, 39] } },
    {
      type: "Feature",
      properties: { name: "b" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [116, 39],
            [118, 39],
            [118, 41],
            [116, 41],
            [116, 39],
          ],
        ],
      },
    },
  ],
});

function tab(partial: Partial<PreviewTab> = {}): PreviewTab {
  return { id: "pv-1", path: "gis/districts.geojson", name: "districts.geojson", kind: "gis", source: "disk", revision: 0, ...partial };
}

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>p</name>
<Point><coordinates>116.39,39.9,0</coordinates></Point></Placemark></Document></kml>`;

/** 只有线要素：用来验证「产物就地更新后多出一种几何」时图层会被补上。 */
const LINE_ONLY = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [116, 39],
          [117, 40],
        ],
      },
    },
  ],
});

let mounted: VueWrapper[] = [];

async function render(overrides?: Partial<PreviewTab>): Promise<VueWrapper> {
  const wrapper = mount(MapViewer, { props: { tab: tab(overrides) }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  mounted = [];
  h.readBinaryFile.mockReset().mockImplementation(async () => new TextEncoder().encode(GEOJSON));
  h.hasHostCommands.mockReset().mockReturnValue(true);
  h.addSource.mockReset();
  h.addLayer.mockReset();
  h.setData.mockReset();
  h.fitBounds.mockReset();
  h.setFeatureState.mockReset();
  h.removeFeatureState.mockReset();
  h.setLayoutProperty.mockReset();
  h.removed.mockReset();
  h.handlers.clear();
  h.queryResult = [];
  h.styleLoaded = true;
});

/** 触发 mock 上的地图事件（queryRenderedFeatures 的结果由 h.queryResult 决定）。 */
function fire(event: "click" | "mousemove" | "mouseout", payload: unknown = {}): void {
  h.handlers.get(event)?.(payload);
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("MapViewer", () => {
  it("解析 geojson 后建 source 并按几何类型分图层", async () => {
    const wrapper = await render();
    expect(h.addSource).toHaveBeenCalledTimes(1);
    const layers = h.addLayer.mock.calls.map((call) => call[0] as { id: string; type: string; filter: unknown[] });
    expect(layers.map((layer) => layer.id)).toEqual(["gw-preview-data-point", "gw-preview-data-polygon"]);
    expect(layers.map((layer) => layer.type)).toEqual(["circle", "fill"]);
    // 每个图层都按 geometry-type 过滤，而不是靠要素顺序
    expect(layers[0].filter).toEqual(["==", ["geometry-type"], "Point"]);
    expect(layers[1].filter).toEqual(["==", ["geometry-type"], "Polygon"]);
    expect(wrapper.get('[data-testid="gis-stats"]').text()).toContain("2");
  });

  it("视野按数据包围盒自动 fit", async () => {
    await render();
    expect(h.fitBounds).toHaveBeenCalledWith(
      [
        [116, 39],
        [118, 41],
      ],
      expect.objectContaining({ duration: 0 }),
    );
  });

  it("style 未就绪时等到 load 再建 source（否则 addSource 会抛）", async () => {
    h.styleLoaded = false;
    await render();
    // once("load") 在 mock 里同步回调，所以这里仍然建上了
    expect(h.addSource).toHaveBeenCalledTimes(1);
  });

  it("非法 GeoJSON 给可见错误条与外部打开出口", async () => {
    h.readBinaryFile.mockResolvedValue(new TextEncoder().encode('{"type":"Nope"}'));
    const wrapper = await render();
    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toContain("不是合法的 GeoJSON");
    expect(h.addSource).not.toHaveBeenCalled();
  });

  it("读取失败（超 20MB 等）走读取错误分支", async () => {
    h.readBinaryFile.mockRejectedValue(new Error("文件超过 20MB 上限"));
    const wrapper = await render();
    expect(wrapper.get('[role="alert"]').text()).toContain("文件超过 20MB 上限");
    expect(wrapper.find('[data-testid="gis-stage"]').exists()).toBe(false);
  });

  it("「适应范围」按钮重新 fit", async () => {
    const wrapper = await render();
    h.fitBounds.mockClear();
    await wrapper.get('[data-testid="gis-fit"]').trigger("click");
    expect(h.fitBounds).toHaveBeenCalledTimes(1);
  });

  it("产物就地更新（revision 变、tab 不变）：只 setData 并补上新几何的图层，不重建 source", async () => {
    const wrapper = await render();
    expect(h.addSource).toHaveBeenCalledTimes(1);
    expect(h.addLayer).toHaveBeenCalledTimes(2); // 首个文件是点 + 面
    h.setData.mockClear();
    h.addLayer.mockClear();
    h.fitBounds.mockClear();

    // 同一个 tab 换内容：组件实例不重建，走的是同一个 map。
    h.readBinaryFile.mockResolvedValue(new TextEncoder().encode(LINE_ONLY));
    await wrapper.setProps({ tab: tab({ revision: 1 }) });
    await flushPromises();

    expect(h.addSource).toHaveBeenCalledTimes(1); // 不重复建 source
    expect(h.setData).toHaveBeenCalledTimes(1);
    // 新出现的「线」必须补上图层，否则线要素静默不显示。
    expect(h.addLayer.mock.calls.map((call) => (call[0] as { id: string }).id)).toEqual(["gw-preview-data-line"]);
    // 刷新不该把用户已经缩放到的视野拽回去。
    expect(h.fitBounds).not.toHaveBeenCalled();
  });

  it("点击要素打开属性面板，并按要素下标设置 selected 状态", async () => {
    const wrapper = await render();
    // 下标 1 = 那个面要素；面板读的是原始集合里的 properties（name: b）。
    h.queryResult = [{ id: 1 }];
    fire("click", { point: [10, 10], lngLat: { lng: 117, lat: 40 } });
    await flushPromises();

    expect(h.setFeatureState).toHaveBeenCalledWith({ source: "gw-preview-data", id: 1 }, { selected: true });
    const panel = wrapper.get('[data-testid="gis-feature-panel"]');
    expect(panel.text()).toContain("name");
    expect(panel.text()).toContain("b");
  });

  it("点击空白处关闭属性面板，并清掉选中状态", async () => {
    const wrapper = await render();
    h.queryResult = [{ id: 1 }];
    fire("click", { point: [10, 10], lngLat: { lng: 117, lat: 40 } });
    await flushPromises();

    h.queryResult = [];
    fire("click", { point: [0, 0], lngLat: { lng: 0, lat: 0 } });
    await flushPromises();

    expect(h.setFeatureState).toHaveBeenLastCalledWith({ source: "gw-preview-data", id: 1 }, { selected: false });
    expect(wrapper.find('[data-testid="gis-feature-panel"]').exists()).toBe(false);
  });

  it("悬停设置 hover 状态并在地图上显示经纬度读数", async () => {
    const wrapper = await render();
    h.queryResult = [{ id: 0 }];
    fire("mousemove", { point: [5, 5], lngLat: { lng: 116.39123, lat: 39.90789 } });
    await flushPromises();

    expect(h.setFeatureState).toHaveBeenCalledWith({ source: "gw-preview-data", id: 0 }, { hover: true });
    expect(wrapper.get('[data-testid="gis-cursor"]').text()).toBe("116.39123, 39.90789");

    fire("mouseout");
    await flushPromises();
    expect(h.setFeatureState).toHaveBeenLastCalledWith({ source: "gw-preview-data", id: 0 }, { hover: false });
    expect(wrapper.find('[data-testid="gis-cursor"]').exists()).toBe(false);
  });

  it("点/线/面图层可单独显隐", async () => {
    const wrapper = await render();
    const pointToggle = wrapper.get('[data-testid="gis-shape-point"]');
    expect(pointToggle.attributes("aria-pressed")).toBe("true");

    await pointToggle.trigger("click");
    expect(h.setLayoutProperty).toHaveBeenCalledWith("gw-preview-data-point", "visibility", "none");
    expect(pointToggle.attributes("aria-pressed")).toBe("false");

    await pointToggle.trigger("click");
    expect(h.setLayoutProperty).toHaveBeenCalledWith("gw-preview-data-point", "visibility", "visible");
  });

  it("投影坐标（米）：不自动 fit，并给出提示", async () => {
    h.readBinaryFile.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({
          type: "FeatureCollection",
          features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [500000, 4649776] } }],
        }),
      ),
    );
    const wrapper = await render();
    expect(h.fitBounds).not.toHaveBeenCalled();
    const notice = wrapper.get('[data-testid="gis-notice-projected"]');
    expect(notice.text()).toContain("EPSG:4326");
  });

  it("空要素集合：提示没有要素，也不 fit", async () => {
    h.readBinaryFile.mockResolvedValue(new TextEncoder().encode(JSON.stringify({ type: "FeatureCollection", features: [] })));
    const wrapper = await render();
    expect(h.fitBounds).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="gis-notice-empty"]').exists()).toBe(true);
  });

  it("几何为空的要素计入「跳过」提示，但仍画其余要素", async () => {
    h.readBinaryFile.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({
          type: "FeatureCollection",
          features: [
            { type: "Feature", properties: {}, geometry: null },
            { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [116, 39] } },
          ],
        }),
      ),
    );
    const wrapper = await render();
    expect(wrapper.get('[data-testid="gis-notice-skipped"]').text()).toContain("1");
    expect(h.addLayer).toHaveBeenCalledTimes(1);
  });

  it("按扩展名分派解析器：.kml 走 KML 转换而不是 GeoJSON", async () => {
    h.readBinaryFile.mockResolvedValue(new TextEncoder().encode(KML));
    const wrapper = await render({ path: "gis/route.kml", name: "route.kml" });
    expect(h.addSource).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="gis-stats"]').text()).toContain("1");
    expect(h.addLayer.mock.calls.map((call) => (call[0] as { id: string }).id)).toEqual(["gw-preview-data-point"]);
  });

  it("注入特征集合（CSV 地图模式）：不读文件，直接画点", async () => {
    const features: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { name: "a" }, geometry: { type: "Point", coordinates: [116, 39] } }],
    };
    const wrapper = mount(MapViewer, {
      props: { tab: tab({ kind: "csv", path: "out/rows.csv", name: "rows.csv" }), features },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();

    // .csv 不是二进制 kind：真去读会抛「不是二进制类型」，能画出来就证明走了注入路径。
    expect(h.readBinaryFile).not.toHaveBeenCalled();
    expect(h.addSource).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="gis-stats"]').text()).toContain("1");
  });

  it("卸载时移除地图", async () => {
    const wrapper = await render();
    wrapper.unmount();
    mounted = mounted.filter((item) => item !== wrapper);
    expect(h.removed).toHaveBeenCalled();
  });
});
