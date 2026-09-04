/**
 * 工作区根目录解析优先级：当前对话所属工作区 → 当前激活工作区 → 设置项/主目录兜底。
 *
 * 这条链决定了右栏文件树、产物落盘与 ACP agent 三者看到的是不是同一个目录。
 * 顺序错了会出现「树里看不到 agent 刚写的文件」这类找不到原因的问题，所以钉住它。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type * as GreyWorkAcp from "@greywork/acp";

const h = vi.hoisted(() => ({
  conversationFolder: vi.fn<() => string | null>(),
  workspaceFolder: vi.fn<() => string | null>(),
  homeDir: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("@/lib/conversation-folder", () => ({ activeConversationFolder: () => h.conversationFolder() }));
vi.mock("@/lib/artifact-dir", () => ({ activeWorkspaceFolder: () => h.workspaceFolder() }));
vi.mock("@greywork/acp", async (importOriginal) => ({
  ...(await importOriginal<typeof GreyWorkAcp>()),
  desktopHomeDir: () => h.homeDir(),
}));

import { resolveWorkspaceRoot } from "@/lib/workspace-dir";
import { useSettingsStore } from "@/stores/settings";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  h.conversationFolder.mockReturnValue(null);
  h.workspaceFolder.mockReturnValue(null);
  h.homeDir.mockResolvedValue("/home/jean");
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
    // 兜底不该去问主目录：设置项已经给出答案
    expect(h.homeDir).not.toHaveBeenCalled();
  });

  it("设置项也为空时回落桌面主目录，仍标记 bound=false", async () => {
    await expect(resolveWorkspaceRoot()).resolves.toEqual({ dir: "/home/jean", bound: false });
  });

  it("主目录都解析不出来时抛错，而不是返回空路径", async () => {
    h.homeDir.mockResolvedValue(null);

    await expect(resolveWorkspaceRoot()).rejects.toThrow();
  });
});
