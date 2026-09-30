/**
 * 3D 预览（ModelViewer）：三条硬契约。
 *
 * 1. 模型走媒体通道的 **bytes** 偏好（要整份字节才能交给 GLTFLoader），且额度是 64MB
 *    而不是 20MB —— 后者会让稍大的模型直接「读不出来」；
 * 2. 解析失败必须落到可见的错误条 + 「用系统应用打开」，不能留一个空场景；
 *    `.gltf` 引用外部资源时给的是专门的出路提示（导出 .glb）；
 * 3. 卸载要把 renderer dispose 掉 —— 切一次 tab 换一份 WebGL 上下文，不释放就是显存泄漏。
 *
 * three 整体被 mock：happy-dom 没有 WebGL，真实 renderer 建不起来，而这里要验的是
 * 数据流与生命周期，不是渲染结果。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import type { PreviewTab } from "@/stores/preview";

const h = vi.hoisted(() => ({
  readMediaFile: vi.fn<(path: string, maxBytes?: number) => Promise<Uint8Array>>(),
  readBinary: vi.fn<(path: string) => Promise<Uint8Array>>(),
  hasHostCommands: vi.fn<() => boolean>(),
  mediaStreamUrl: vi.fn<(path: string) => string | null>(),
  parse: vi.fn<(buffer: ArrayBuffer, path: string, onLoad: (gltf: unknown) => void, onError: (cause: unknown) => void) => void>(),
  render: vi.fn(),
  rendererDisposed: vi.fn(),
  controlsDisposed: vi.fn(),
  triangles: 6,
}));

vi.mock("@/stores/vfs", () => ({ useVfsStore: () => ({ readBinary: h.readBinary }) }));
vi.mock("@/state/workspaceFiles", () => ({
  readBinaryFile: vi.fn(),
  readMediaFile: h.readMediaFile,
  readTextFile: vi.fn(),
}));
vi.mock("@greywork/host-ipc", () => ({
  hasHostCommands: h.hasHostCommands,
  mediaStreamUrl: h.mediaStreamUrl,
}));

vi.mock("three", () => {
  class Vector3 {
    constructor(
      public x = 0,
      public y = 0,
      public z = 0,
    ) {}
    set(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
    copy(other: Vector3) {
      return this.set(other.x, other.y, other.z);
    }
  }
  class Box3 {
    setFromObject() {
      return this;
    }
    isEmpty() {
      return false;
    }
    getSize() {
      return new Vector3(2, 2, 2);
    }
    getCenter() {
      return new Vector3(0, 0, 0);
    }
  }
  class Object3D {
    add() {}
    remove() {}
    traverse() {}
  }
  return {
    Vector3,
    Box3,
    Object3D,
    Scene: class extends Object3D {},
    PerspectiveCamera: class {
      position = new Vector3();
      near = 0.01;
      far = 100;
      fov = 45;
      aspect = 1;
      updateProjectionMatrix() {}
    },
    WebGLRenderer: class {
      domElement = document.createElement("canvas");
      setPixelRatio() {}
      setSize() {}
      render() {
        h.render();
      }
      dispose() {
        h.rendererDisposed();
      }
    },
    HemisphereLight: class {},
    DirectionalLight: class {
      position = new Vector3();
    },
  };
});

vi.mock("three/addons/controls/OrbitControls.js", () => ({
  OrbitControls: class {
    target = { copy() {} };
    enableDamping = false;
    autoRotate = false;
    autoRotateSpeed = 1;
    update() {}
    dispose() {
      h.controlsDisposed();
    }
  },
}));

vi.mock("three/addons/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    parse(buffer: ArrayBuffer, path: string, onLoad: (gltf: unknown) => void, onError: (cause: unknown) => void) {
      h.parse(buffer, path, onLoad, onError);
    }
  },
}));

import ModelViewer from "@/features/preview/ModelViewer.vue";

/**
 * 假模型：traverse 回调一个带几何的网格，供 stats 统计。
 *
 * `getIndex().count` 是**索引数**而不是三角面数（three 的真实语义），所以给的是
 * `triangles * 3` —— 让 `h.triangles` 这个旋钮表示三角面数，与断言对齐。
 * 几何必须带 `dispose()`：卸载路径会 traverse 一遍逐项释放。
 */
function fakeScene() {
  return {
    traverse: (visit: (child: unknown) => void) =>
      visit({
        geometry: {
          getIndex: () => ({ count: h.triangles * 3 }),
          getAttribute: () => ({ count: h.triangles * 3 }),
          dispose: () => {},
        },
      }),
  };
}

function tab(partial: Partial<PreviewTab> = {}): PreviewTab {
  return { id: "pv-1", path: "models/scene.glb", name: "scene.glb", kind: "3d", source: "disk", revision: 0, ...partial };
}

let mounted: VueWrapper[] = [];

async function render(overrides?: Partial<PreviewTab>): Promise<VueWrapper> {
  const wrapper = mount(ModelViewer, { props: { tab: tab(overrides) }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  mounted = [];
  h.readMediaFile.mockReset().mockImplementation(async () => new Uint8Array([1, 2, 3, 4]));
  h.readBinary.mockReset().mockImplementation(async () => new Uint8Array([1, 2, 3, 4]));
  h.hasHostCommands.mockReset().mockReturnValue(true);
  h.mediaStreamUrl.mockReset().mockReturnValue("gwmedia://localhost/models/scene.glb");
  h.parse.mockReset().mockImplementation((_buffer, _path, onLoad) => onLoad({ scene: fakeScene() }));
  h.render.mockReset();
  h.rendererDisposed.mockReset();
  h.controlsDisposed.mockReset();
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("ModelViewer", () => {
  it("走媒体通道的 bytes 偏好：即便有流式地址也读字节，额度 64MB", async () => {
    await render();
    expect(h.readMediaFile).toHaveBeenCalledWith("models/scene.glb", 64 * 1024 * 1024);
    // 流式地址在这里没用：GLTFLoader 要的是整份字节。
    expect(h.parse).toHaveBeenCalledTimes(1);
    expect(h.parse.mock.calls[0][1]).toBe("");
  });

  it("解析成功后显示网格与三角面统计", async () => {
    const wrapper = await render();
    expect(wrapper.get('[data-testid="model-stats"]').text()).toContain("6");
  });

  it("解析失败给出错误条与「用系统应用打开」出口", async () => {
    h.parse.mockImplementation((_buffer, _path, _onLoad, onError) => onError(new Error("bad magic")));
    const wrapper = await render();
    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toContain("bad magic");
    expect(alert.text()).toContain("无法解析");
  });

  it(".gltf 解析失败时给的是「导出 .glb」的出路提示", async () => {
    h.parse.mockImplementation((_buffer, _path, _onLoad, onError) => onError(new Error("404 scene.bin")));
    const wrapper = await render({ path: "models/scene.gltf", name: "scene.gltf" });
    expect(wrapper.get('[role="alert"]').text()).toContain(".glb");
  });

  it("读取失败（超限等）走的是读取错误分支，不显示模型区域", async () => {
    h.readMediaFile.mockRejectedValue(new Error("文件超过 64MB 上限"));
    const wrapper = await render();
    expect(wrapper.get('[role="alert"]').text()).toContain("文件超过 64MB 上限");
    expect(wrapper.find('[data-testid="model-stage"]').exists()).toBe(false);
  });

  it("自动旋转开关切换 aria-pressed", async () => {
    const wrapper = await render();
    const button = wrapper.get('[data-testid="model-auto-rotate"]');
    expect(button.attributes("aria-pressed")).toBe("true");
    await button.trigger("click");
    expect(button.attributes("aria-pressed")).toBe("false");
  });

  it("卸载时释放 renderer 与控制器（切 tab 不泄漏 WebGL 上下文）", async () => {
    const wrapper = await render();
    wrapper.unmount();
    mounted = mounted.filter((item) => item !== wrapper);
    expect(h.rendererDisposed).toHaveBeenCalled();
    expect(h.controlsDisposed).toHaveBeenCalled();
  });
});
