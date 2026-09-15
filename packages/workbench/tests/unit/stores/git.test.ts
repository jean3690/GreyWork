/**
 * Git 变更面板 store：真实磁盘 GitService（经宿主 git CLI）的状态编排。
 *
 * 三层边界：
 * - 浏览器态（非 Tauri）整体回落空态，不去挑根、不装 GitService —— 网页里没有磁盘；
 * - Tauri 态每次 `refresh` 都重解析工作区根并新建 GitService（根可能换了，服务不缓存跨根）；
 * - 宿主调用契约由 `@greywork/editor` 的 Tauri 适配器承担，这里只断言转发到的 invoke 形参
 *   （command + root），不 mock 中间层 —— 真契约一旦改了，测试立刻报警。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type * as GreyWorkCore from "@greywork/core";

const h = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  resolveRoot: vi.fn<() => Promise<{ dir: string; bound: boolean }>>(),
}));

vi.mock("@greywork/core", async (importOriginal) => ({
  ...(await importOriginal<typeof GreyWorkCore>()),
  isTauriRuntime: () => h.isTauri(),
}));
vi.mock("@/lib/workspace-dir", () => ({ resolveWorkspaceRoot: () => h.resolveRoot() }));
vi.mock("@/lib/conversation-folder", () => ({ activeConversationFolder: () => null }));
vi.mock("@/lib/artifact-dir", () => ({ activeWorkspaceFolder: () => null }));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { useGitStore } from "@/stores/git";

const changed = (overrides: Partial<Record<string, unknown>> = {}) => ({
  path: "a.txt",
  status: "modified",
  staged: false,
  add: 1,
  del: 0,
  ...overrides,
});

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  h.isTauri.mockReturnValue(true);
  h.resolveRoot.mockResolvedValue({ dir: "/ws", bound: true });
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "git_changes") return Promise.resolve([changed()]);
    if (cmd === "git_current_branch") return Promise.resolve("main\n");
    if (cmd === "git_diff") return Promise.resolve("diff --git a/a.txt b/a.txt\n");
    if (cmd === "git_commit") return Promise.resolve({ hash: "abc123", message: "init", timestamp: "2026-01-01T00:00:00" });
    return Promise.reject(new Error(`意外的命令 ${cmd}`));
  });
});

describe("useGitStore", () => {
  it("浏览器态回落空态：不解析根、不建服务、无错误", async () => {
    h.isTauri.mockReturnValue(false);
    const git = useGitStore();
    await git.refresh();
    expect(git.root).toBeNull();
    expect(git.entries).toEqual([]);
    expect(git.error).toBeNull();
    expect(h.resolveRoot).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refresh 解析工作区根并把变更与分支落到状态", async () => {
    const git = useGitStore();
    await git.refresh();
    expect(git.root).toBe("/ws");
    expect(invokeMock).toHaveBeenCalledWith("git_changes", { root: "/ws" });
    expect(invokeMock).toHaveBeenCalledWith("git_current_branch", { root: "/ws" });
    expect(git.branch).toBe("main");
    expect(git.entries).toEqual([changed()]);
    expect(git.error).toBeNull();
  });

  it("changes 失败（非 git 仓库）时报错并清空条目，分支照常读取", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "git_changes") return Promise.reject("不是仓库");
      if (cmd === "git_current_branch") return Promise.resolve("main\n");
      return Promise.reject(new Error("意外"));
    });
    const git = useGitStore();
    await git.refresh();
    expect(git.entries).toEqual([]);
    expect(git.error).toBe("不是仓库");
  });

  it("select 拉取 diff 并缓存；重复选择复用缓存不重复调用", async () => {
    const git = useGitStore();
    await git.refresh();
    await git.select("a.txt");
    expect(git.selected).toBe("a.txt");
    expect(git.diffCache["a.txt"]).toContain("diff --git");
    await git.select("a.txt");
    expect(invokeMock).toHaveBeenCalledTimes(3); // changes + branch + diff
  });

  it("deselect 收起选中", async () => {
    const git = useGitStore();
    await git.refresh();
    await git.select("a.txt");
    git.deselect();
    expect(git.selected).toBeNull();
  });

  it("commitAll 成功后清空提交框并刷新列表", async () => {
    const git = useGitStore();
    await git.refresh();
    git.commitMessage = "改动 ";
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "git_commit") return Promise.resolve({ hash: "abc123", message: "改动", timestamp: "2026-01-01T00:00:00" });
      if (cmd === "git_changes") return Promise.resolve([]);
      if (cmd === "git_current_branch") return Promise.resolve("main\n");
      return Promise.reject(new Error("意外"));
    });
    await git.commitAll();
    expect(invokeMock).toHaveBeenCalledWith("git_commit", { root: "/ws", message: "改动" });
    expect(git.lastCommitId).toBe("abc123");
    expect(git.commitMessage).toBe("");
    expect(git.entries).toEqual([]);
  });

  it("commitAll 失败只报错不动状态", async () => {
    const git = useGitStore();
    await git.refresh();
    git.commitMessage = "改";
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "git_commit") return Promise.reject("没有可提交的变更");
      if (cmd === "git_current_branch") return Promise.resolve("main\n");
      if (cmd === "git_changes") return Promise.resolve([changed()]);
      return Promise.reject(new Error("意外"));
    });
    await git.commitAll();
    expect(git.commitError).toBe("没有可提交的变更");
    expect(git.commitMessage).toBe("改");
    expect(git.entries).toEqual([changed()]);
  });

  it("空白提交信息不发起提交", async () => {
    const git = useGitStore();
    await git.refresh();
    git.commitMessage = "   ";
    await git.commitAll();
    expect(invokeMock).not.toHaveBeenCalledWith("git_commit", expect.any(Object));
  });
});
