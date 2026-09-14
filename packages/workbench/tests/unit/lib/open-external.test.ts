/**
 * 「用系统应用打开」桥：桌面态走宿主 open_path，浏览器态直接回 false（无磁盘通道），
 * 宿主报错也只回 false 不抛（打开失败不该打断预览）。
 * 另外覆盖 tab → 磁盘路径的解析：disk 源用 path，vfs 产物用落盘时带回的 diskPath。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

import { openWithSystemApp, resolveTabDiskPath } from "../../../src/lib/open-external";
import type { PreviewTab } from "../../../src/stores/preview";

function tab(partial: Partial<PreviewTab>): PreviewTab {
  return { id: "pv-1", path: "artifacts/a.xlsx", name: "a.xlsx", kind: "xlsx", source: "vfs", revision: 0, ...partial };
}

afterEach(() => {
  vi.unstubAllGlobals();
  invokeMock.mockReset();
});

describe("openWithSystemApp", () => {
  it("浏览器态回 false，不触 invoke", async () => {
    expect(await openWithSystemApp("/tmp/a.xlsx")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  describe("桌面态", () => {
    beforeEach(() => {
      vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    });

    it("以 open_path + path 调用宿主并回 true", async () => {
      invokeMock.mockResolvedValue(undefined);
      expect(await openWithSystemApp("/home/u/.greyWork/artifacts/a.xlsx")).toBe(true);
      expect(invokeMock).toHaveBeenCalledWith("open_path", { path: "/home/u/.greyWork/artifacts/a.xlsx" });
    });

    it("宿主拒绝（路径已删 / 无关联程序）时回 false 而不抛", async () => {
      invokeMock.mockRejectedValue(new Error("路径不存在"));
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(await openWithSystemApp("/gone/a.xlsx")).toBe(false);
    });
  });
});

describe("resolveTabDiskPath", () => {
  it("disk 源的 path 本身就是磁盘路径", () => {
    expect(resolveTabDiskPath(tab({ source: "disk", path: "/data/proj/artifacts/a.xlsx" }))).toBe("/data/proj/artifacts/a.xlsx");
  });

  it("vfs 产物取落盘带回的 diskPath；disk 源的 diskPath 不参与（path 才是真源）", () => {
    expect(resolveTabDiskPath(tab({ diskPath: "/home/u/.greyWork/artifacts/a.xlsx" }))).toBe("/home/u/.greyWork/artifacts/a.xlsx");
    expect(resolveTabDiskPath(tab({ source: "disk", path: "/data/a.xlsx", diskPath: "/stale/b.xlsx" }))).toBe("/data/a.xlsx");
  });

  it("纯内存文件与抓取的网页没有磁盘孪生，回 null", () => {
    expect(resolveTabDiskPath(tab({}))).toBeNull();
    expect(resolveTabDiskPath(tab({ source: "web", path: "https://example.com/a", kind: "web" }))).toBeNull();
  });
});
