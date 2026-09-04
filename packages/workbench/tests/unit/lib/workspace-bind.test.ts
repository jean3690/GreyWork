/**
 * 绑定文件夹 = 记住新目录 + 搬迁既有会话。这条契约存在的原因：只记不搬时，
 * 已绑旧目录的历史会话不会跟过来，用户看到的是「换了文件夹，历史对话消失」。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const h = vi.hoisted(() => ({ relocate: vi.fn() }));

vi.mock("../../../src/lib/session-relocate", () => ({
  relocateWorkspaceSessions: (workspaceId: string, from: string | undefined, to: string | undefined) => h.relocate(workspaceId, from, to),
}));

import { bindWorkspaceFolder } from "../../../src/lib/workspace-bind";
import { useWorkspaceStore } from "../../../src/stores/workspace";

beforeEach(() => {
  setActivePinia(createPinia());
  globalThis.localStorage?.clear();
  vi.clearAllMocks();
  h.relocate.mockResolvedValue({ moved: 3, missing: [], conflicts: [] });
});

describe("bindWorkspaceFolder", () => {
  it("先记住新文件夹，再以「旧目录 → 新目录」搬迁", async () => {
    const store = useWorkspaceStore();
    const workspace = store.createWorkspace("演示");
    store.setFolder(workspace.id, "/old/proj");

    const report = await bindWorkspaceFolder(workspace.id, "/new/proj");

    expect(report.moved).toBe(3);
    expect(store.workspaceById(workspace.id)?.folder).toBe("/new/proj");
    expect(h.relocate).toHaveBeenCalledWith(workspace.id, "/old/proj", "/new/proj");
  });

  it("首次绑定：from 为 undefined（会话原本在默认根）", async () => {
    const store = useWorkspaceStore();
    const workspace = store.createWorkspace("新项目");
    await bindWorkspaceFolder(workspace.id, "/first/proj");
    expect(h.relocate).toHaveBeenCalledWith(workspace.id, undefined, "/first/proj");
  });

  it("文件夹没变 → 不搬迁", async () => {
    const store = useWorkspaceStore();
    const workspace = store.createWorkspace("演示");
    store.setFolder(workspace.id, "/same");
    expect(await bindWorkspaceFolder(workspace.id, "/same")).toEqual({ moved: 0, missing: [], conflicts: [] });
    expect(h.relocate).not.toHaveBeenCalled();
  });

  it("搬迁抛错时保留绑定（用户的明确意图不回滚）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.relocate.mockRejectedValue(new Error("宿主拒绝"));
    const store = useWorkspaceStore();
    const workspace = store.createWorkspace("演示");
    expect(await bindWorkspaceFolder(workspace.id, "/new")).toEqual({ moved: 0, missing: [], conflicts: [] });
    expect(store.workspaceById(workspace.id)?.folder).toBe("/new");
  });
});
