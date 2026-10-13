/**
 * 「在文件夹中打开」桥：桌面态走宿主 reveal_path，浏览器态直接回 false
 * （无磁盘通道），宿主报错也只回 false 不抛（卡片不该因为打开失败崩掉）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ revealPath: vi.fn() }));

vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal()),
  invoke: vi.fn(),
}));
const invokeMock = vi.mocked((await import("@greywork/host-ipc")).invoke);

import { revealInFolder } from "../../../src/lib/reveal";

afterEach(() => {
  vi.unstubAllGlobals();
  invokeMock.mockReset();
});

describe("revealInFolder", () => {
  it("浏览器态回 false，不触 invoke", async () => {
    expect(await revealInFolder("/tmp/a.md")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  describe("桌面态（Electron bridge）", () => {
    beforeEach(() => {
      vi.stubGlobal("window", {
        __GREYWORK_RUNTIME__: "server",
        __GREYWORK_SHELL__: { window: {}, app: { revealPath: bridge.revealPath } },
      });
    });

    it("以 hostApp().revealPath 调用宿主并回 true", async () => {
      bridge.revealPath.mockResolvedValue(undefined);
      expect(await revealInFolder("/home/u/.greyWork/artifacts/report.md")).toBe(true);
      expect(bridge.revealPath).toHaveBeenCalledWith("/home/u/.greyWork/artifacts/report.md");
    });

    it("宿主拒绝（路径已删）时回 false 而不抛", async () => {
      bridge.revealPath.mockRejectedValue(new Error("路径不存在"));
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(await revealInFolder("/gone/x.md")).toBe(false);
    });
  });
});
