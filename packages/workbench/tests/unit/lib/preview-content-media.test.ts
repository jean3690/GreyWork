/**
 * 媒体通道的分派：`resolvePreviewMedia` 必须优先给出**流式地址**，只有宿主没有自定义协议时
 * 才回落到读字节。
 *
 * 这条分派是「视频能不能打开」的唯一开关。走错方向的症状是「一直转圈、不出画面、也没有
 * 任何报错」—— 全量读入 + 主线程 `new Blob` 同步拷贝把界面卡死，而 WebKit 还要把整个 blob
 * 拉完才开始播。所以这里既断言「有协议时不读字节」，也断言「没协议时读的是放宽上限的那条
 * 命令」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readBinaryFile: vi.fn<(path: string) => Promise<Uint8Array>>(),
  readMediaFile: vi.fn<(path: string, maxBytes?: number) => Promise<Uint8Array>>(),
  readTextFile: vi.fn<(path: string) => Promise<string>>(),
  hasHostCommands: vi.fn<() => boolean>(),
  mediaStreamUrl: vi.fn<(path: string) => string | null>(),
  vfsReadBinary: vi.fn<(path: string) => Promise<Uint8Array>>(),
}));

vi.mock("@/state/workspaceFiles", () => ({
  readBinaryFile: h.readBinaryFile,
  readMediaFile: h.readMediaFile,
  readTextFile: h.readTextFile,
}));
vi.mock("@greywork/host-ipc", () => ({
  hasHostCommands: h.hasHostCommands,
  mediaStreamUrl: h.mediaStreamUrl,
}));
vi.mock("@/stores/vfs", () => ({ useVfsStore: () => ({ readBinary: h.vfsReadBinary }) }));

import { readPreviewBinary, resolvePreviewMedia } from "@/lib/preview-content";
import type { PreviewTab } from "@/stores/preview";

function tab(partial: Partial<PreviewTab> = {}): PreviewTab {
  return { id: "pv-1", path: "/ws/clips/take.mp4", name: "take.mp4", kind: "video", source: "disk", revision: 0, ...partial };
}

beforeEach(() => {
  h.readBinaryFile.mockReset().mockResolvedValue(new Uint8Array([1]));
  h.readMediaFile.mockReset().mockResolvedValue(new Uint8Array([2]));
  h.readTextFile.mockReset().mockResolvedValue("");
  h.vfsReadBinary.mockReset().mockResolvedValue(new Uint8Array([3]));
  h.hasHostCommands.mockReset().mockReturnValue(true);
  h.mediaStreamUrl.mockReset().mockReturnValue(null);
});

describe("resolvePreviewMedia 的通道分派", () => {
  it("宿主有 gwmedia 协议时给流式地址，并且**一个字节都不读**", async () => {
    h.mediaStreamUrl.mockReturnValue("gwmedia://localhost/%2Fws%2Fclips%2Ftake.mp4");

    const source = await resolvePreviewMedia(tab(), "/ws/clips/take.mp4");

    expect(source).toEqual({ kind: "stream", url: "gwmedia://localhost/%2Fws%2Fclips%2Ftake.mp4" });
    // 这就是这一层存在的意义：流式那条路不读字节，所以 128MB 的视频也是秒开。
    expect(h.readMediaFile).not.toHaveBeenCalled();
    expect(h.readBinaryFile).not.toHaveBeenCalled();
  });

  it("宿主没有该协议（服务端 / 浏览器预览）时回落到媒体读取，并带上该 kind 申请的额度", async () => {
    const source = await resolvePreviewMedia(tab(), "/ws/clips/take.mp4");

    expect(h.readMediaFile).toHaveBeenCalledWith("/ws/clips/take.mp4", 128 * 1024 * 1024);
    expect(source).toEqual({ kind: "bytes", bytes: new Uint8Array([2]) });
  });

  it("VFS 来源不碰宿主命令（内存文件系统本就没有上限，也没有磁盘路径可流式）", async () => {
    const source = await resolvePreviewMedia(tab({ source: "vfs" }), "clips/take.mp4");

    expect(h.vfsReadBinary).toHaveBeenCalledWith("clips/take.mp4");
    expect(h.mediaStreamUrl).not.toHaveBeenCalled();
    expect(source).toEqual({ kind: "bytes", bytes: new Uint8Array([3]) });
  });

  it("非媒体 kind 直接拒绝", async () => {
    await expect(resolvePreviewMedia(tab({ kind: "md" }), "a.md")).rejects.toThrow("不是媒体类型");
    expect(h.readMediaFile).not.toHaveBeenCalled();
  });

  it("浏览器态没有磁盘通道：给一句人话而不是 command not found", async () => {
    h.hasHostCommands.mockReturnValue(false);
    await expect(resolvePreviewMedia(tab(), "/ws/clips/take.mp4")).rejects.toThrow("浏览器态没有磁盘通道");
  });
});

describe("readPreviewBinary 不再承担媒体", () => {
  it("磁盘上的图片走 fs_read_binary（20MB 契约）", async () => {
    const bytes = await readPreviewBinary(tab({ kind: "image", path: "/ws/imgs/pic.png" }), "/ws/imgs/pic.png");
    expect(h.readBinaryFile).toHaveBeenCalledWith("/ws/imgs/pic.png");
    expect(h.readMediaFile).not.toHaveBeenCalled();
    expect(bytes).toEqual(new Uint8Array([1]));
  });

  it("媒体 kind 走这条路会被拦下：那条 20MB 硬顶会把视频静默挡掉", async () => {
    await expect(readPreviewBinary(tab(), "/ws/clips/take.mp4")).rejects.toThrow("必须走媒体通道");
    expect(h.readBinaryFile).not.toHaveBeenCalled();
    expect(h.readMediaFile).not.toHaveBeenCalled();
  });

  it("非二进制 kind 直接拒绝：走错通道会经 utf-8 解码不可逆损坏", async () => {
    await expect(readPreviewBinary(tab({ kind: "md" }), "a.md")).rejects.toThrow("不是二进制类型");
  });
});
