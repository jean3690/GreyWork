/**
 * 预览侧栏「变更」区段的可观察行为：分区渲染、点条目展开那一侧的 diff、
 * 逐文件暂存 / 取消暂存、只提交已暂存（外加「提交全部」）。
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

import GitChangePanel from "@/features/preview/GitChangePanel.vue";
import { useGitStore } from "@/stores/git";
import { i18n } from "@/i18n";

const t = i18n.global.t;

/** a.txt 两侧都有改动（porcelain 的 `MM`），new.txt 只在未暂存侧。 */
const CHANGES = [
  { path: "a.txt", oldPath: null, index: "modified", worktree: "modified", stagedAdd: 1, stagedDel: 0, add: 1, del: 0 },
  { path: "new.txt", oldPath: null, index: null, worktree: "untracked", stagedAdd: 0, stagedDel: 0, add: 0, del: 0 },
];

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
    if (command === "git_changes") return Promise.resolve(CHANGES);
    if (command === "git_current_branch") return Promise.resolve("main\n");
    if (command === "git_diff") return Promise.resolve(DIFF);
    if (command === "git_stage" || command === "git_unstage") return Promise.resolve(undefined);
    if (command === "git_commit") return Promise.resolve({ hash: "abc123", message: "改动", timestamp: "2026-01-01T00:00:00" });
    return Promise.reject(new Error(`意外的命令 ${command}`));
  });
});

describe("GitChangePanel", () => {
  it("渲染分支、条数、两个分区与底部提交框", async () => {
    const wrapper = mount(GitChangePanel);
    await flushPromises();

    expect(wrapper.text()).toContain("main");
    expect(wrapper.text()).toContain(t("preview.git.files", { n: 2 }));
    // a.txt 两侧都有改动 → 两个分区各一条；new.txt 只在未暂存侧
    expect(wrapper.findAll('[data-testid="git-entry"]')).toHaveLength(3);
    expect(wrapper.get('[data-testid="git-group-index"]').text()).toContain(t("preview.git.stagedGroup", { n: 1 }));
    expect(wrapper.get('[data-testid="git-group-work"]').text()).toContain(t("preview.git.unstagedGroup", { n: 2 }));
    expect(wrapper.find('[data-testid="git-commit-box"]').exists()).toBe(true);
  });

  it("点条目拉取**那一侧**的 diff 并就地展开", async () => {
    const wrapper = mount(GitChangePanel);
    await flushPromises();

    // 第一行是「已暂存」区的 a.txt
    const first = wrapper.findAll('[data-testid="git-entry"]')[0];
    expect(first.attributes("data-side")).toBe("index");
    await first.trigger("click");
    await flushPromises();

    expect(h.invoke).toHaveBeenCalledWith("git_diff", { root: "/ws", path: "a.txt", staged: true });
    const diff = wrapper.get('[data-testid="git-entry-diff"]');
    expect(diff.text()).toContain("+two");
    expect(diff.text()).toContain("a.txt");
  });

  it("同一路径的两侧：缓存各留一份（一次只展开一条，切换侧不串内容）", async () => {
    const wrapper = mount(GitChangePanel);
    await flushPromises();

    const entries = wrapper.findAll('[data-testid="git-entry"]');
    const workRow = entries.find((entry) => entry.attributes("data-side") === "work" && entry.attributes("data-path") === "a.txt")!;
    await workRow.trigger("click");
    await flushPromises();
    expect(h.invoke).toHaveBeenCalledWith("git_diff", { root: "/ws", path: "a.txt", staged: false });

    // 再点已暂存那条：单条展开（折叠上一条），走的是 index 侧的 diff
    const stagedRow = entries.find((entry) => entry.attributes("data-side") === "index")!;
    await stagedRow.trigger("click");
    await flushPromises();
    expect(h.invoke).toHaveBeenCalledWith("git_diff", { root: "/ws", path: "a.txt", staged: true });
    expect(wrapper.findAll('[data-testid="git-entry-diff"]')).toHaveLength(1);

    // 两份缓存并存：切回未暂存那条不再重新拉 diff
    const git = useGitStore();
    expect(Object.keys(git.diffCache).sort()).toEqual(["index:a.txt", "work:a.txt"]);
    const calls = h.invoke.mock.calls.filter(([command]) => command === "git_diff").length;
    await workRow.trigger("click");
    await flushPromises();
    expect(h.invoke.mock.calls.filter(([command]) => command === "git_diff").length).toBe(calls);
  });

  it("再点同一条目收起 diff", async () => {
    const wrapper = mount(GitChangePanel);
    await flushPromises();

    const entry = wrapper.findAll('[data-testid="git-entry"]')[0];
    await entry.trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="git-entry-diff"]').exists()).toBe(true);

    await entry.trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="git-entry-diff"]').exists()).toBe(false);
  });

  it("未暂存那行的加号：调 git_stage 暂存单个文件", async () => {
    const wrapper = mount(GitChangePanel);
    await flushPromises();

    const stageButtons = wrapper.findAll('[data-testid="git-stage"]');
    expect(stageButtons).toHaveLength(2); // a.txt 与 new.txt 的未暂存行各一个
    await stageButtons[0].trigger("click");
    await flushPromises();

    expect(h.invoke).toHaveBeenCalledWith("git_stage", { root: "/ws", paths: ["a.txt"], all: false });
  });

  it("已暂存那行的减号：调 git_unstage", async () => {
    const wrapper = mount(GitChangePanel);
    await flushPromises();

    await wrapper.get('[data-testid="git-unstage"]').trigger("click");
    await flushPromises();

    expect(h.invoke).toHaveBeenCalledWith("git_unstage", { root: "/ws", paths: ["a.txt"], all: false });
  });

  it("头部的「全部暂存 / 全部取消暂存」", async () => {
    const wrapper = mount(GitChangePanel);
    await flushPromises();

    await wrapper.get('[data-testid="git-stage-all"]').trigger("click");
    await flushPromises();
    expect(h.invoke).toHaveBeenCalledWith("git_stage", { root: "/ws", paths: [], all: true });

    await wrapper.get('[data-testid="git-unstage-all"]').trigger("click");
    await flushPromises();
    expect(h.invoke).toHaveBeenCalledWith("git_unstage", { root: "/ws", paths: [], all: true });
  });

  it("填提交信息并提交：只提交已暂存，成功后清空提交框", async () => {
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

    expect(h.invoke).toHaveBeenCalledWith("git_commit", { root: "/ws", message: "改动", all: false });
    expect(useGitStore().commitMessage).toBe("");
    // 提交后的空列表 → 展示空态
    expect(wrapper.text()).toContain(t("preview.git.empty"));
  });

  it("「提交全部变更」走 add -A 那一路（all=true）", async () => {
    const wrapper = mount(GitChangePanel);
    await flushPromises();

    await wrapper.get("#git-commit-input").setValue("全部改动");
    await wrapper.get('[data-testid="git-commit-all"]').trigger("click");
    await flushPromises();

    expect(h.invoke).toHaveBeenCalledWith("git_commit", { root: "/ws", message: "全部改动", all: true });
  });

  it("提交信息为空、或没有已暂存内容时主按钮禁用", async () => {
    const wrapper = mount(GitChangePanel);
    await flushPromises();

    const button = wrapper.get('[data-testid="git-commit-submit"]');
    expect(button.attributes("disabled")).toBeDefined();
    await wrapper.get("#git-commit-input").setValue("改动");
    expect(button.attributes("disabled")).toBeUndefined();

    // 只剩未暂存的改动 → 主按钮再次禁用（「提交全部」仍可用）
    h.invoke.mockImplementation((command: string) => {
      if (command === "git_changes") return Promise.resolve([CHANGES[1]]);
      if (command === "git_current_branch") return Promise.resolve("main\n");
      return Promise.reject(new Error(`意外的命令 ${command}`));
    });
    await useGitStore().refresh();
    await flushPromises();
    expect(wrapper.get('[data-testid="git-commit-submit"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="git-commit-all"]').attributes("disabled")).toBeUndefined();
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
