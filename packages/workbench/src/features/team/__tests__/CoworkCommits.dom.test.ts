/**
 * 协作「提交」卡：展示队友产出的提交、标记本轮新增、按需展开 diff。
 * cowork store 真身起 run 太重，这里 mock 掉只喂提交相关字段。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

interface FakeCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  timestamp: string;
  subject: string;
  refs: string;
  fromRun: boolean;
}

const h = vi.hoisted(() => ({
  state: {
    runWorkspace: null as string | null,
    runBranch: null as string | null,
    commitViews: [] as unknown[],
    commitsAvailable: true,
    commitsLoading: false,
    commitsError: null as string | null,
    commitDiffCache: {} as Record<string, string>,
    commitDiffLoading: false,
    commitDiffError: null as string | null,
  },
  refreshCommits: vi.fn(),
  loadCommitDiff: vi.fn(),
}));

vi.mock("@/stores/cowork", () => ({
  useCoworkStore: () => ({ ...h.state, refreshCommits: h.refreshCommits, loadCommitDiff: h.loadCommitDiff }),
}));

import CoworkCommits from "@/features/team/CoworkCommits.vue";
import { i18n } from "@/i18n";

const t = i18n.global.t;

function commit(overrides: Partial<FakeCommit> = {}): FakeCommit {
  return {
    hash: "aaaa1111",
    shortHash: "aaaa111",
    author: "Builder",
    email: "b@x",
    timestamp: "2026-01-01T10:00:00Z",
    subject: "feat: add login",
    refs: "",
    fromRun: false,
    ...overrides,
  };
}

function mountCard() {
  setActivePinia(createPinia());
  return mount(CoworkCommits, { global: { plugins: [i18n] } });
}

beforeEach(() => {
  h.state = {
    runWorkspace: "/ws",
    runBranch: "greywork/demo",
    commitViews: [],
    commitsAvailable: true,
    commitsLoading: false,
    commitsError: null,
    commitDiffCache: {},
    commitDiffLoading: false,
    commitDiffError: null,
  };
  h.refreshCommits.mockReset();
  h.loadCommitDiff.mockReset();
});

describe("CoworkCommits", () => {
  it("无协作工作区时整段零渲染", () => {
    h.state.runWorkspace = null;
    const wrapper = mountCard();
    expect(wrapper.find('[data-testid="cowork-commits"]').exists()).toBe(false);
    expect(wrapper.text()).toBe("");
  });

  it("渲染提交行、分支名与本轮标记，刷新按钮触发刷新", async () => {
    h.state.commitViews = [commit(), commit({ hash: "bbbb2222", shortHash: "bbbb222", subject: "fix: review", fromRun: true })];
    const wrapper = mountCard();

    expect(wrapper.text()).toContain("greywork/demo");
    expect(wrapper.get('[data-testid="cowork-commit-aaaa111"]').text()).toContain("feat: add login");
    const fromRunRow = wrapper.get('[data-testid="cowork-commit-bbbb222"]');
    expect(fromRunRow.text()).toContain("fix: review");
    expect(fromRunRow.text()).toContain(t("cowork.commits.fromRun"));

    await wrapper.get('[data-testid="cowork-commits-refresh"]').trigger("click");
    expect(h.refreshCommits).toHaveBeenCalledTimes(1);
  });

  it("空提交给提示；非 git 工作区给不可用提示", () => {
    const empty = mountCard();
    expect(empty.text()).toContain(t("cowork.commits.empty"));

    h.state.commitsAvailable = false;
    const unavailable = mountCard();
    expect(unavailable.text()).toContain(t("cowork.commits.noRepo"));
  });

  it("点提交行按需拉 diff；已缓存的 diff 直接展示", async () => {
    h.state.commitViews = [commit()];
    h.state.commitDiffCache = { aaaa1111: "diff --git a b" };
    const wrapper = mountCard();

    await wrapper.get('[data-testid="cowork-commit-aaaa111"]').trigger("click");
    expect(h.loadCommitDiff).toHaveBeenCalledWith("aaaa1111");
    expect(wrapper.find("pre").text()).toContain("diff --git a b");

    // 再点一次收起，diff 不再展示
    await wrapper.get('[data-testid="cowork-commit-aaaa111"]').trigger("click");
    expect(wrapper.find("pre").exists()).toBe(false);
  });
});
