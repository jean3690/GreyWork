/**
 * GIS 预览（MapViewer）：四条硬契约。
 *
 * 1. 按整份字节读（`fs_read_binary` 的 20MB 通道）—— GIS 不是媒体 kind；
 * 2. 要素按几何类型分成点/线/面三个图层，而不是按第一个要素决定画法；
 * 3. 视野按数据包围盒自动 fit，且**不挂底图**（空 style，没有任何外部请求）；
 * 4. 解析失败给可见错误条，卸载要 `map.remove()`。
 *
 * MapLibre 被 mock：happy-dom 没有 WebGL，这里验的是数据流与生命周期。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import type { PreviewTab } from "@/stores/preview";

const h = vi.hoisted(() => ({
  readBinaryFile: vi.fn<(path: string) => Promise<Uint8Array>>(),
  readTextFile: vi.fn<(path: string) => Promise<string>>(),
  hasHostCommands: vi.fn<() => boolean>(),
  addSource: vi.fn<(id: string, spec: unknown) => void>(),
  addLayer: vi.fn<(layer: unknown) => void>(),
  setData: vi.fn<(data: unknown) => void>(),
  fitBounds: vi.fn<(bounds: unknown, options: unknown) => void>(),
  removed: vi.fn(),
  styleLoaded: true,
}));

vi.mock("@/stores/vfs", () => ({ useVfsStore: () => ({ readBinary: vi.fn(), readFile: vi.fn() }) }));
vi.mock("@/state/workspaceFiles", () => ({
  readBinaryFile: h.readBinaryFile,
  readTextFile: h.readTextFile,
  readMediaFile: vi.fn(),
}));
vi.mock("@greywork/host-ipc", () => ({ hasHostCommands: h.hasHostCommands, mediaStreamUrl: () => null }));

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
  h.removed.mockReset();
  h.styleLoaded = true;
});

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

  it("卸载时移除地图", async () => {
    const wrapper = await render();
    wrapper.unmount();
    mounted = mounted.filter((item) => item !== wrapper);
    expect(h.removed).toHaveBeenCalled();
  });
});
