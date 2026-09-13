/**
 * 工作区根目录解析优先级：当前对话所属工作区 → 当前激活工作区 → 设置项/主目录兜底。
 *
 * 这条链决定了右栏文件树、产物落盘与 ACP agent 三者看到的是不是同一个目录。
 * 顺序错了会出现「树里看不到 agent 刚写的文件」这类找不到原因的问题，所以钉住它。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { isTauriRuntime } from "@greywork/core";
import type * as GreyWorkCore from "@greywork/core";

const h = vi.hoisted(() => ({
  conversationFolder: vi.fn<() => string | null>(),
  workspaceFolder: vi.fn<() => string | null>(),
  invoke: vi.fn(),
}));

vi.mock("@/lib/conversation-folder", () => ({ activeConversationFolder: () => h.conversationFolder() }));
vi.mock("@/lib/artifact-dir", () => ({ activeWorkspaceFolder: () => h.workspaceFolder() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => h.invoke(...args) }));
vi.mock("@greywork/core", async (importOriginal) => ({
  ...(await importOriginal<typeof GreyWorkCore>()),
  isTauriRuntime: vi.fn(),
}));

import { resolveWorkspaceRoot } from "@/lib/workspace-dir";
import { useSettingsStore } from "@/stores/settings";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  h.conversationFolder.mockReturnValue(null);
  h.workspaceFolder.mockReturnValue(null);
  h.invoke.mockResolvedValue("/home/jean/.greyWork");
  vi.mocked(isTauriRuntime).mockReturnValue(true);
});

describe("resolveWorkspaceRoot", () => {
  it("对话所属工作区的文件夹优先于激活工作区", async () => {
    h.conversationFolder.mockReturnValue("/data/talk");
    h.workspaceFolder.mockReturnValue("/data/active");

    await expect(resolveWorkspaceRoot()).resolves.toEqual({ dir: "/data/talk", bound: true });
  });

  it("没有对话归属时取激活工作区的文件夹", async () => {
    h.workspaceFolder.mockReturnValue("/data/active");

    await expect(resolveWorkspaceRoot()).resolves.toEqual({ dir: "/data/active", bound: true });
  });

  it("都没绑定时回落设置项，并标记 bound=false", async () => {
    useSettingsStore().workspaceDir = "/opt/configured";

    await expect(resolveWorkspaceRoot()).resolves.toEqual({ dir: "/opt/configured", bound: false });
    expect(h.invoke).not.toHaveBeenCalledWith("store_default_root");
  });

  it("都没绑定时回落宿主私有数据根，仍标记 bound=false", async () => {
    await expect(resolveWorkspaceRoot()).resolves.toEqual({ dir: "/home/jean/.greyWork", bound: false });
    expect(h.invoke).toHaveBeenCalledWith("store_default_root");
  });

  it("浏览器态没有本机工作区时抛错，而不是返回伪路径", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(false);
    await expect(resolveWorkspaceRoot()).rejects.toThrow();
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
