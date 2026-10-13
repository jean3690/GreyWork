/**
 * 媒体流式地址门面。
 *
 * 这里要钉住的是一条契约：**服务端态**给同源 `/api/media` 地址（路径整条百分号编码，
 * 特殊字符可完整还原）；浏览器预览态拿到 `null`，让预览层回落到读字节 ——
 * 漏了这条，`<video>` 会拿到一个永远加载不出来的地址，表现是「一直转圈、没有任何报错」。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { mediaStreamUrl } from "../../src/media";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mediaStreamUrl", () => {
  it("服务端态：同源 /api/media 地址（路径整条百分号编码）", () => {
    vi.stubGlobal("window", { __GREYWORK_RUNTIME__: "server" });
    expect(mediaStreamUrl("/ws/clips/take.mp4")).toBe("/api/media?path=%2Fws%2Fclips%2Ftake.mp4");
  });

  it("服务端态：带特殊字符的路径编码后仍可被 `?path=` 完整还原", () => {
    vi.stubGlobal("window", { __GREYWORK_RUNTIME__: "server" });
    const url = mediaStreamUrl("/ws/片 名&x=1.mp4");
    const path = new URL(url ?? "", "http://x").searchParams.get("path");
    expect(path).toBe("/ws/片 名&x=1.mp4");
  });

  it("浏览器预览：返回 null（没有宿主，预览层回落读字节）", () => {
    vi.stubGlobal("window", {});
    expect(mediaStreamUrl("/ws/clips/take.mp4")).toBeNull();
  });

  it("空路径返回 null（没有磁盘孪生的产物不该拼出个假地址）", () => {
    vi.stubGlobal("window", { __GREYWORK_RUNTIME__: "server" });
    expect(mediaStreamUrl("")).toBeNull();
  });
});
