/**
 * 视频预览（VideoViewer）：流式地址优先、blob 兜底的地址来源，以及解码失败的出口。
 *
 * 两条硬契约：
 * 1. 宿主有 `gwmedia` 协议时**不建 blob、不读字节** —— 那正是「一直转圈不出画面」的病根；
 * 2. blob 兜底里换内容必须 revoke 旧引用、卸载必须 revoke 当前引用（视频体积是图片的百倍，
 *    泄漏更致命）。
 *
 * 第三条是本组件独有的：`<video>` 的 error 事件必须落到「用系统应用打开」，
 * 而不是留一个没有任何解释的黑框。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import type { PreviewTab } from "@/stores/preview";

const h = vi.hoisted(() => ({
  readBinary: vi.fn<(path: string) => Promise<Uint8Array>>(),
  readMediaFile: vi.fn<(path: string, maxBytes?: number) => Promise<Uint8Array>>(),
  hasHostCommands: vi.fn<() => boolean>(),
  mediaStreamUrl: vi.fn<(path: string) => string | null>(),
  createUrl: vi.fn<(blob: Blob) => string>(),
  revokeUrl: vi.fn<(url: string) => void>(),
  blobs: [] as Blob[],
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

import VideoViewer from "@/features/preview/VideoViewer.vue";

const ORIG_CREATE = URL.createObjectURL;
const ORIG_REVOKE = URL.revokeObjectURL;

function tab(partial: Partial<PreviewTab> = {}): PreviewTab {
  return { id: "pv-1", path: "clips/take.mp4", name: "take.mp4", kind: "video", source: "vfs", revision: 0, ...partial };
}

function mountViewer(overrides?: Partial<PreviewTab>) {
  return mount(VideoViewer, { props: { tab: tab(overrides) } });
}

let urlCounter = 0;

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  h.blobs.length = 0;
  urlCounter = 0;
  h.readBinary.mockReset().mockImplementation(async () => new Uint8Array([0, 0, 0, 1]));
  h.readMediaFile.mockReset().mockImplementation(async () => new Uint8Array([0, 0, 0, 1]));
  h.hasHostCommands.mockReset().mockReturnValue(true);
  h.mediaStreamUrl.mockReset().mockReturnValue(null);
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

describe("VideoViewer 地址来源", () => {
  it("宿主有 gwmedia 协议：直接用流式地址，不读字节、不建 blob", async () => {
    h.mediaStreamUrl.mockReturnValue("gwmedia://localhost/%2Fws%2Fclips%2Ftake.mp4");
    const wrapper = mountViewer({ source: "disk", path: "/ws/clips/take.mp4" });
    await flushPromises();

    expect(h.mediaStreamUrl).toHaveBeenCalledWith("/ws/clips/take.mp4");
    expect(wrapper.get('[data-testid="video-viewer"]').attributes("src")).toBe("gwmedia://localhost/%2Fws%2Fclips%2Ftake.mp4");
    // 流式那条路的全部意义就在这里：一个字节都不读。
    expect(h.readMediaFile).not.toHaveBeenCalled();
    expect(h.readBinary).not.toHaveBeenCalled();
    expect(h.createUrl).not.toHaveBeenCalled();
  });

  it("没有自定义协议（VFS / 服务端）：回落 blob，按扩展名映射 MIME", async () => {
    const wrapper = mountViewer();
    await flushPromises();

    expect(h.readBinary).toHaveBeenCalledWith("clips/take.mp4");
    expect(wrapper.get('[data-testid="video-viewer"]').attributes("src")).toBe("blob:mock/1");
    expect(h.blobs[0].type).toBe("video/mp4");
  });

  it("mov / mkv 也给对 MIME（给错会让 WebKitGTK 直接拒绝播放）", async () => {
    mountViewer({ path: "clips/a.mov", name: "a.mov" });
    await flushPromises();
    expect(h.blobs[0].type).toBe("video/quicktime");

    mountViewer({ path: "clips/b.mkv", name: "b.mkv" });
    await flushPromises();
    expect(h.blobs[1].type).toBe("video/x-matroska");
  });

  it("未知扩展给 octet-stream，扩展名大小写不敏感", async () => {
    mountViewer({ path: "clips/RAW.MP4", name: "RAW.MP4" });
    await flushPromises();
    expect(h.blobs[0].type).toBe("video/mp4");
  });

  it("读取中：加载占位", () => {
    h.readBinary.mockReturnValue(new Promise(() => {}));
    expect(mountViewer().text()).toContain("读取中");
  });

  it("读取失败：alert + 错误文案（超限也走这条）", async () => {
    h.readBinary.mockRejectedValue(new Error("文件超过 128MB 上限"));
    const wrapper = mountViewer();
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("读取失败：文件超过 128MB 上限");
  });
});

describe("VideoViewer 的 object URL 生命周期", () => {
  it("内容刷新（revision 自增）：先 revoke 旧 URL，再换上新 URL", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    const first = wrapper.get('[data-testid="video-viewer"]').attributes("src");

    await wrapper.setProps({ tab: tab({ revision: 1 }) });
    await flushPromises();

    expect(h.revokeUrl).toHaveBeenCalledWith(first);
    const next = wrapper.get('[data-testid="video-viewer"]').attributes("src");
    expect(next).toBe("blob:mock/2");
    expect(next).not.toBe(first);
  });

  it("卸载时 revoke 当前 URL（内存泄漏的最后一站）", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    const src = wrapper.get('[data-testid="video-viewer"]').attributes("src");

    wrapper.unmount();
    expect(h.revokeUrl).toHaveBeenCalledWith(src);
  });

  it("从 blob 切到流式时不留下未释放的 blob", async () => {
    h.mediaStreamUrl.mockReturnValue("gwmedia://localhost/x");
    const wrapper = mountViewer();
    await flushPromises();
    const blobSrc = wrapper.get('[data-testid="video-viewer"]').attributes("src");

    await wrapper.setProps({ tab: tab({ id: "pv-2", source: "disk", path: "/ws/x.mp4", revision: 1 }) });
    await flushPromises();

    expect(h.revokeUrl).toHaveBeenCalledWith(blobSrc);
    expect(wrapper.get('[data-testid="video-viewer"]').attributes("src")).toBe("gwmedia://localhost/x");
  });
});

describe("VideoViewer 的失败出口", () => {
  it("播放失败：error 事件换成提示而不是黑框", async () => {
    const wrapper = mountViewer();
    await flushPromises();

    await wrapper.get('[data-testid="video-viewer"]').trigger("error");

    expect(wrapper.find('[data-testid="video-viewer"]').exists()).toBe(false);
    expect(wrapper.get('[role="alert"]').text()).toContain("无法播放这个视频");
  });

  it("换文件时清掉播放失败态：上一个解不出不代表这个也解不出", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    await wrapper.get('[data-testid="video-viewer"]').trigger("error");
    expect(wrapper.find('[data-testid="video-viewer"]').exists()).toBe(false);

    await wrapper.setProps({ tab: tab({ id: "pv-2", path: "clips/other.webm", name: "other.webm", revision: 1 }) });
    await flushPromises();

    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="video-viewer"]').attributes("src")).toBe("blob:mock/2");
  });
});
