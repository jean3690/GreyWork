/**
 * 媒体流式地址门面。
 *
 * 这里要钉住的是一条契约：**只有桌面壳**才给得出 `gwmedia://` 地址，且协议名与路径原样交给
 * `convertFileSrc`（由它按平台拼成 `gwmedia://localhost/...` 或 `http://gwmedia.localhost/...`，
 * 并做 `encodeURIComponent`）。服务端 / 浏览器预览必须拿到 `null`，让预览层回落到读字节 ——
 * 漏了这条，`<video>` 会拿到一个永远加载不出来的地址，表现是「一直转圈、没有任何报错」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GreyworkCore from "@greywork/core";

const mocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn<() => boolean>(() => false),
  convertFileSrc: vi.fn<(path: string, protocol?: string) => string>(),
}));

vi.mock("@greywork/core", async (importOriginal) => ({
  ...(await importOriginal<typeof GreyworkCore>()),
  isTauriRuntime: mocks.isTauriRuntime,
}));

import { mediaStreamUrl } from "../../src/media";

/** 装一个最小 window，带上 Tauri 注入的 `convertFileSrc`。 */
function stubDesktop(): void {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { convertFileSrc: mocks.convertFileSrc } });
}

beforeEach(() => {
  mocks.isTauriRuntime.mockReturnValue(false);
  mocks.convertFileSrc.mockReset().mockImplementation((path, protocol) => `${protocol}://localhost/${encodeURIComponent(path)}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mediaStreamUrl", () => {
  it("桌面态：协议名与路径原样交给 convertFileSrc", () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    stubDesktop();

    expect(mediaStreamUrl("/ws/clips/take.mp4")).toBe("gwmedia://localhost/%2Fws%2Fclips%2Ftake.mp4");
    // 协议名是 Rust 侧 `media_protocol::SCHEME` 与 tauri.conf.json media-src 的第三份副本。
    expect(mocks.convertFileSrc).toHaveBeenCalledWith("/ws/clips/take.mp4", "gwmedia");
  });

  it("服务端 / 浏览器预览：返回 null，且根本不碰 convertFileSrc", () => {
    stubDesktop();
    expect(mediaStreamUrl("/ws/clips/take.mp4")).toBeNull();
    expect(mocks.convertFileSrc).not.toHaveBeenCalled();
  });

  it("空路径返回 null（没有磁盘孪生的产物不该拼出个假地址）", () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    stubDesktop();
    expect(mediaStreamUrl("")).toBeNull();
    expect(mocks.convertFileSrc).not.toHaveBeenCalled();
  });
});
