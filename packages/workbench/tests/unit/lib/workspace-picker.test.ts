/**
 * 工作区文件夹挑选（lib/workspace-picker）：有原生选择器时只走宿主系统对话框；
 * 否则走应用内手输路径弹层（lib/path-prompt）。
 *
 * 后者刻意**不是** window.prompt —— Chromium 不实现 prompt，调用即抛错，表现就是
 * 自托管 Web / 浏览器态点「添加工作区」「绑定文件夹」毫无反应。本文件守住这条分岔。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ requestPathInput: vi.fn() }));

vi.mock("@/lib/path-prompt", () => ({ requestPathInput: h.requestPathInput }));

import { pickWorkspaceFolder } from "@/lib/workspace-picker";

beforeEach(() => {
  h.requestPathInput.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pickWorkspaceFolder", () => {
  it("有原生选择器：只问 host 的系统目录对话框（选中路径经授权命令回规范值）", async () => {
    vi.stubGlobal("window", {
      __GREYWORK_RUNTIME__: "server",
      __GREYWORK_SHELL__: { window: {}, picker: { openFiles: vi.fn(), openDirectory: () => Promise.resolve("/host/raw") } },
    });
    // 授权命令走 shell.ts 内部的 invoke（相对导入，包级 mock 管不到）→ stub fetch。
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(["/host/allowed/path"]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(pickWorkspaceFolder()).resolves.toBe("/host/allowed/path");
    expect(fetchMock).toHaveBeenCalledWith("/api/command", expect.objectContaining({ method: "POST" }));
    expect(h.requestPathInput).not.toHaveBeenCalled();
  });

  it("原生对话框取消 → null，不弹手输层", async () => {
    vi.stubGlobal("window", {
      __GREYWORK_RUNTIME__: "server",
      __GREYWORK_SHELL__: { window: {}, picker: { openFiles: vi.fn(), openDirectory: () => Promise.resolve(null) } },
    });

    await expect(pickWorkspaceFolder()).resolves.toBeNull();
    expect(h.requestPathInput).not.toHaveBeenCalled();
  });

  it("没有原生选择器 → 走应用内手输路径弹层", async () => {
    vi.stubGlobal("window", {});
    h.requestPathInput.mockResolvedValue("/srv/data/project");

    await expect(pickWorkspaceFolder()).resolves.toBe("/srv/data/project");
    expect(h.requestPathInput).toHaveBeenCalledOnce();
  });

  it("手输层取消 → null", async () => {
    vi.stubGlobal("window", {});
    h.requestPathInput.mockResolvedValue(null);

    await expect(pickWorkspaceFolder()).resolves.toBeNull();
  });
});
