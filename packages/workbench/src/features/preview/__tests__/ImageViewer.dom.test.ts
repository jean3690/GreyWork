/**
 * 图片预览（ImageViewer）：二进制读取 → Blob → object URL 的生命周期。
 * 这份组件的核心契约是 URL memory：换内容必须 revoke 旧引用、卸载必须 revoke 当前引用，
 * 否则切几十个 tab 就是几十份图片钉在内存里。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import type { PreviewTab } from "@/stores/preview";

const h = vi.hoisted(() => ({
  readBinary: vi.fn<(path: string) => Promise<Uint8Array>>(),
  createUrl: vi.fn<(blob: Blob) => string>(),
  revokeUrl: vi.fn<(url: string) => void>(),
  blobs: [] as Blob[],
}));

vi.mock("@/stores/vfs", () => ({ useVfsStore: () => ({ readBinary: h.readBinary }) }));

import ImageViewer from "@/features/preview/ImageViewer.vue";

const ORIG_CREATE = URL.createObjectURL;
const ORIG_REVOKE = URL.revokeObjectURL;

function tab(partial: Partial<PreviewTab> = {}): PreviewTab {
  return { id: "pv-1", path: "imgs/pic.png", name: "pic.png", kind: "image", source: "vfs", revision: 0, ...partial };
}

function mountViewer(overrides?: Partial<PreviewTab>) {
  return mount(ImageViewer, { props: { tab: tab(overrides) } });
}

let urlCounter = 0;

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  h.blobs.length = 0;
  urlCounter = 0;
  h.readBinary.mockReset().mockImplementation(async () => new Uint8Array([1, 2, 3]));
  h.createUrl.mockReset().mockImplementation((blob) => {
    h.blobs.push(blob);
    return `blob:mock/${++urlCounter}`;
  });
  h.revokeUrl.mockReset();
  URL.createObjectURL = h.createUrl;
  URL.revokeObjectURL = h.revokeUrl;
});

afterEach(() => {
  URL.createObjectURL = ORIG_CREATE;
  URL.revokeObjectURL = ORIG_REVOKE;
});

describe("ImageViewer", () => {
  it("读取中：加载占位", () => {
    h.readBinary.mockReturnValue(new Promise(() => {}));
    expect(mountViewer().text()).toContain("读取中");
  });

  it("读取失败：alert + 错误文案", async () => {
    h.readBinary.mockRejectedValue(new Error("boom"));
    const wrapper = mountViewer();
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("读取失败：boom");
  });

  it("按扩展名映射 MIME，为 img 提供 src 与 alt", async () => {
    const wrapper = mountViewer();
    await flushPromises();

    expect(h.readBinary).toHaveBeenCalledWith("imgs/pic.png");
    const img = wrapper.get('[data-testid="image-viewer"]');
    expect(img.attributes("src")).toBe("blob:mock/1");
    expect(img.attributes("alt")).toBe("pic.png");
    expect(h.blobs[0].type).toBe("image/png");
  });

  it("未知扩展给 octet-stream，扩展名大小写不敏感", async () => {
    mountViewer({ path: "out/data.bin", name: "data.bin", kind: "image" });
    await flushPromises();
    expect(h.blobs[0].type).toBe("application/octet-stream");

    mountViewer({ path: "photos/IMG.JPG", name: "IMG.JPG", kind: "image" });
    await flushPromises();
    expect(h.blobs[1].type).toBe("image/jpeg");
  });

  it("内容刷新（revision 自增）：现在旧 URL，换上新 URL", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    const first = wrapper.get('[data-testid="image-viewer"]').attributes("src");

    await wrapper.setProps({ tab: tab({ revision: 1 }) });
    await flushPromises();

    expect(h.revokeUrl).toHaveBeenCalledWith(first);
    const next = wrapper.get('[data-testid="image-viewer"]').attributes("src");
    expect(next).toBe("blob:mock/2");
    expect(next).not.toBe(first);
  });

  it("卸载时 revoke 当前 URL（这是内存泄漏的最后一站）", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    const src = wrapper.get('[data-testid="image-viewer"]').attributes("src");

    wrapper.unmount();
    expect(h.revokeUrl).toHaveBeenCalledWith(src);
  });
});

describe("ImageViewer 视图变换", () => {
  /** 当前倍率文案，如 "125%"。 */
  function level(wrapper: ReturnType<typeof mountViewer>): string {
    return wrapper.get('[data-testid="image-zoom-level"]').text();
  }

  function styleOf(wrapper: ReturnType<typeof mountViewer>): string {
    return wrapper.get('[data-testid="image-viewer"]').attributes("style") ?? "";
  }

  it("缩放按钮改倍率，「适应」能一键回到 100%", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    expect(level(wrapper)).toBe("100%");

    await wrapper.get('[data-testid="image-zoom-in"]').trigger("click");
    expect(level(wrapper)).toBe("125%");
    await wrapper.get('[data-testid="image-zoom-out"]').trigger("click");
    expect(level(wrapper)).toBe("100%");
    await wrapper.get('[data-testid="image-zoom-in"]').trigger("click");
    await wrapper.get('[data-testid="image-fit"]').trigger("click");
    expect(level(wrapper)).toBe("100%");
  });

  it("旋转把角度写进 transform，左右各一下回到 0", async () => {
    const wrapper = mountViewer();
    await flushPromises();

    await wrapper.get('[data-testid="image-rotate-right"]').trigger("click");
    expect(styleOf(wrapper)).toContain("rotate(90deg)");
    await wrapper.get('[data-testid="image-rotate-left"]').trigger("click");
    expect(styleOf(wrapper)).toContain("rotate(0deg)");
  });

  it("内容刷新（revision 自增）后视图归位：沿用上一张的缩放会让人以为新图坏了", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    await wrapper.get('[data-testid="image-zoom-in"]').trigger("click");
    await wrapper.get('[data-testid="image-rotate-right"]').trigger("click");
    expect(styleOf(wrapper)).toContain("rotate(90deg)");

    await wrapper.setProps({ tab: tab({ revision: 1 }) });
    await flushPromises();

    expect(level(wrapper)).toBe("100%");
    expect(styleOf(wrapper)).toContain("rotate(0deg)");
  });

  it("旋转会重新适应：转过 90° 的图不会溢出容器（布局不可测时退回 1）", async () => {
    const wrapper = mountViewer();
    await flushPromises();

    await wrapper.get('[data-testid="image-zoom-in"]').trigger("click");
    expect(wrapper.get('[data-testid="image-fit"]').attributes("aria-pressed")).toBe("false");

    await wrapper.get('[data-testid="image-rotate-right"]').trigger("click");
    // 旋转后回到「适应」态：倍率由当前角度下的可容纳尺寸决定
    expect(wrapper.get('[data-testid="image-fit"]').attributes("aria-pressed")).toBe("true");
  });
});
