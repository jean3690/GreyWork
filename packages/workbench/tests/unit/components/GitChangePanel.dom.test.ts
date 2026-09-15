/**
 * 预览侧栏「变更」区段的可观察行为：分支/列表渲染、点条目展开 diff、提交框交互。
 *
 * store 走真实路径（isTauriRuntime 为真），宿主调用经 mock 的 invoke 断言命令契约；
 * 组件不 mock pinia —— 行为即数据流，换实现还得看这批测试的脸色。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type * as GreyWorkCore from "@greywork/core";

const h = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  resolveRoot: vi.fn<() => Promise<{ dir: string; bound: boolean }>>(),
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("@greywork/core", async (importOriginal) => {
  const mod = await importOriginal<typeof GreyWorkCore>();
  return { ...mod, isTauriRuntime: () => h.isTauri() };
});
vi.mock("@/lib/workspace-dir", () => ({ resolveWorkspaceRoot: () => h.resolveRoot() }));
vi.mock("@/lib/conversation-folder", () => ({ activeConversationFolder: () => null }));
vi.mock("@/lib/artifact-dir", () => ({ activeWorkspaceFolder: () => null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => h.invoke(command, args),
}));

import GitChangePanel from "@/components/preview/GitChangePanel.vue";
import { useGitStore } from "@/stores/git";

const DIFF =
  "diff --git a/a.txt b/a.txt\n" +
  "index 1111111..2222222 100644\n" +
  "--- a/a.txt\n" +
  "+++ b/a.txt\n" +
  "@@ -1 +1,2 @@\n" +
  " one\n" +
  "+two\n";

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  vi.clearAllMocks();
  h.isTauri.mockReturnValue(true);
  h.resolveRoot.mockResolvedValue({ dir: "/ws", bound: true });
  h.invoke.mockImplementation((command: string) => {
    if (command === "git_changes")
      return Promise.resolve([
        { path: "a.txt", status: "modified", staged: false, add: 1, del: 0 },
        { path: "new.txt", status: "untracked", staged: false, add: 0, del: 0 },
      ]);
    if (command === "git_current_branch") return Promise.resolve("main\n");
    if (command === "git_diff") return Promise.resolve(DIFF);
    if (command === "git_commit") return Promise.resolve({ hash: "abc123", message: "改动", timestamp: "2026-01-01T00:00:00" });
    return Promise.reject(new Error(`意外的命令 ${command}`));
  });
});

describe("GitChangePanel", () => {
  it("渲染分支、条数与变更条目，底部带提交框", async () => {
    const wrapper = mount(GitChangePanel);
    await flushPromises();

    expect(wrapper.text()).toContain("main");
    expect(wrapper.text()).toContain("2 个文件");
    const entries = wrapper.findAll('[data-testid="git-entry"]');
    expect(entries).toHaveLength(2);
    expect(wrapper.text()).toContain("a.txt");
    expect(wrapper.text()).toContain("new.txt");
    expect(wrapper.find('[data-testid="git-commit-box"]').exists()).toBe(true);
  });

  it("点条目拉取 diff 并就地展开", async () => {
    const wrapper = mount(GitChangePanel);
    await flushPromises();

    await wrapper.get('[data-testid="git-entry"]').trigger("click");
    await flushPromises();

    expect(h.invoke).toHaveBeenCalledWith("git_diff", { root: "/ws", path: "a.txt" });
    const diff = wrapper.get('[data-testid="git-entry-diff"]');
    expect(diff.text()).toContain("+two");
    expect(diff.text()).toContain("a.txt");
  });

  it("再点同一条目收起 diff", async () => {
    const wrapper = mount(GitChangePanel);
    await flushPromises();

    const entry = wrapper.get('[data-testid="git-entry"]');
    await entry.trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="git-entry-diff"]').exists()).toBe(true);

    await wrapper.get('[data-testid="git-entry"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="git-entry-diff"]').exists()).toBe(false);
  });

  it("填提交信息并提交：走宿主 commit、成功后清空提交框", async () => {
    const wrapper = mount(GitChangePanel);
    await flushPromises();

    h.invoke.mockImplementation((command: string) => {
      if (command === "git_commit") return Promise.resolve({ hash: "abc123", message: "改动", timestamp: "2026-01-01T00:00:00" });
      if (command === "git_current_branch") return Promise.resolve("main\n");
      if (command === "git_changes") return Promise.resolve([]);
      return Promise.reject(new Error(`意外的命令 ${command}`));
    });

    await wrapper.get("#git-commit-input").setValue("改动");
    await wrapper.get('[data-testid="git-commit-box"]').trigger("submit");
    await flushPromises();

    expect(h.invoke).toHaveBeenCalledWith("git_commit", { root: "/ws", message: "改动" });
    const git = useGitStore();
    expect(git.commitMessage).toBe("");
    // 提交后的空列表 → 展示空态
    expect(wrapper.text()).toContain("工作区没有未提交的变更");
  });

  it("提交信息为空时提交按钮禁用", async () => {
    const wrapper = mount(GitChangePanel);
    await flushPromises();

    const button = wrapper.get('[data-testid="git-commit-submit"]');
    expect(button.attributes("disabled")).toBeDefined();
    await wrapper.get("#git-commit-input").setValue("改动");
    expect(button.attributes("disabled")).toBeUndefined();
  });

  it("非 git 目录的错误态：显示原因 + 重试按钮", async () => {
    h.invoke.mockImplementation((command: string) => {
      if (command === "git_changes") return Promise.reject("不是 git 仓库");
      if (command === "git_current_branch") return Promise.resolve("main\n");
      return Promise.reject(new Error("意外"));
    });
    const wrapper = mount(GitChangePanel);
    await flushPromises();

    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("不是 git 仓库");
    expect(wrapper.find('[data-testid="git-retry"]').exists()).toBe(true);
  });
});
