/**
 * 工作区文件夹挑选（lib/workspace-picker）：桌面端只走 host 目录对话框，
 * 浏览器/测试态回落 window.prompt 并 trim。invoke / prompt 全 mock，验证分岔逻辑本身。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@greywork/core";

const h = vi.hoisted(() => ({
  isTauri: vi.fn(),
  invoke: vi.fn(),
  prompt: vi.fn(),
}));

vi.mock("@greywork/core", async (importOriginal) => {
  const mod = await importOriginal<typeof CoreModule>();
  return { ...mod, isTauriRuntime: h.isTauri };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import { pickWorkspaceFolder } from "@/lib/workspace-picker";

beforeEach(() => {
  h.isTauri.mockReset().mockReturnValue(true);
  h.invoke.mockReset();
  h.prompt.mockReset();
  vi.stubGlobal("window", { prompt: h.prompt });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pickWorkspaceFolder", () => {
  it("桌面端只问 host 的系统目录对话框", async () => {
    h.invoke.mockResolvedValue("/host/allowed/path");

    await expect(pickWorkspaceFolder()).resolves.toBe("/host/allowed/path");
    expect(h.invoke).toHaveBeenCalledWith("pick_workspace_folder");
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("桌面端对话框取消 → null", async () => {
    h.invoke.mockResolvedValue(null);

    await expect(pickWorkspaceFolder()).resolves.toBeNull();
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("浏览器态回落 prompt，并 trim 掉首尾空白", async () => {
    h.isTauri.mockReturnValue(false);
    h.prompt.mockReturnValue("  /tmp/preview-path  ");

    await expect(pickWorkspaceFolder()).resolves.toBe("/tmp/preview-path");
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("浏览器态：空串 / 纯空白 / 取消（null）→ null", async () => {
    h.isTauri.mockReturnValue(false);
    h.prompt.mockReturnValueOnce("").mockReturnValueOnce("   ").mockReturnValueOnce(null);

    await expect(pickWorkspaceFolder()).resolves.toBeNull();
    await expect(pickWorkspaceFolder()).resolves.toBeNull();
    await expect(pickWorkspaceFolder()).resolves.toBeNull();
  });
});
