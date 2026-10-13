// 协作 run 级工具面（技能 / MCP 勾选）与 git 集成（队友提交）的接线契约。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const h = vi.hoisted(() => ({
  startAgent: vi.fn(),
  openSession: vi.fn(),
  setSessionConfig: vi.fn(),
  prompt: vi.fn(),
  stop: vi.fn(),
  isAvailable: vi.fn(() => true),
  listener: null as ((event: unknown) => void) | null,
  isolateForRun: vi.fn(async (base: string, _options?: unknown) => `/wt${base}`),
  git: {
    currentBranch: vi.fn(async () => "greywork/demo"),
    log: vi.fn(async () => [] as unknown[]),
    show: vi.fn(async () => "diff --git a b"),
    changes: vi.fn(async () => []),
  },
}));

vi.mock("@greywork/acp", () => ({
  createAcpClient: () => ({
    isAvailable: () => h.isAvailable(),
    startAgent: (cmd: string, tier: string, sandbox?: string, workspace?: string | null) => h.startAgent(cmd, tier, sandbox, workspace),
    openSession: (handle: number, cwd: string, mcpServers?: unknown) => h.openSession(handle, cwd, mcpServers),
    setSessionConfig: (handle: number, configId: string, value: string | boolean) => h.setSessionConfig(handle, configId, value),
    setPermissionTier: vi.fn(),
    probeMcp: vi.fn(),
    prompt: (handle: number, text: string, units?: unknown) => h.prompt(handle, text, units),
    stop: (handle: number, turnId?: number) => h.stop(handle, turnId),
    respondPermission: vi.fn(),
    onEvent: (listener: (event: unknown) => void) => {
      h.listener = listener;
      return Promise.resolve(() => undefined);
    },
  }),
  desktopHomeDir: vi.fn(),
}));

vi.mock("@/lib/workspace-dir", () => ({
  resolveWorkspaceDir: () => Promise.resolve("/src/ws"),
  isolateForRun: (base: string, options?: unknown) => h.isolateForRun(base, options as never),
}));

vi.mock("@greywork/editor", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createTauriGitService: () => h.git,
}));

vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hasHostCommands: () => true,
}));

vi.mock("@/state/attachment-library", () => ({
  materializeAttachments: (_sessionId: string, items: readonly unknown[]) => Promise.resolve([...items]),
}));

vi.mock("@/stores/skills", () => ({
  scanSkills: vi.fn(async () => []),
}));

import { useCoworkStore } from "@/stores/cowork";
import { useSettingsStore } from "@/stores/settings";

const storageHolder = globalThis as { localStorage?: Storage };

function injectStorage(): void {
  const backing: Record<string, string> = {};
  storageHolder.localStorage = {
    getItem: (key: string) => backing[key] ?? null,
    setItem: (key: string, value: string) => {
      backing[key] = value;
    },
    removeItem: (key: string) => {
      delete backing[key];
    },
    clear: () => {
      for (const key of Object.keys(backing)) delete backing[key];
    },
    key: (index: number) => Object.keys(backing)[index] ?? null,
    get length() {
      return Object.keys(backing).length;
    },
  } as Storage;
}

function members() {
  let handleSeq = 0;
  h.startAgent.mockImplementation(() => Promise.resolve(++handleSeq));
  h.openSession.mockImplementation((handle: number) =>
    Promise.resolve({ sessionId: `s-${handle}`, configOptions: [], mcpServers: [], skippedMcpServers: [] }),
  );
  h.prompt.mockResolvedValue({ turnId: 1 });
  return [
    { name: "Leader", role: "leader" as const },
    { name: "Builder", role: "teammate" as const },
  ];
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  injectStorage();
  h.isAvailable.mockImplementation(() => true);
  h.isolateForRun.mockImplementation(async (base: string) => `/wt${base}`);
  h.git.currentBranch.mockResolvedValue("greywork/demo");
  h.git.log.mockResolvedValue([]);
  h.git.show.mockResolvedValue("diff --git a b");
});

describe("run 级工具面（技能 / MCP）", () => {
  it("显式 skills 勾选透传给 isolateForRun，选中的 MCP 声明给每个成员会话", async () => {
    const cowork = useCoworkStore();
    const failure = await cowork.startRun("带工具面协作", members(), [], {
      mcpServers: [{ name: "srv", transport: "http", url: "https://example.org/mcp" }],
      skills: ["alpha", "beta"],
    });
    expect(failure).toBeNull();
    // 技能勾选随工作区隔离一起下发
    expect(h.isolateForRun).toHaveBeenCalledWith("/src/ws", { skills: ["alpha", "beta"] });
    // 显式 MCP 面覆盖设置默认，两个成员都拿到
    expect(h.openSession).toHaveBeenCalledTimes(2);
    for (const call of h.openSession.mock.calls) {
      expect(call[2]).toEqual([{ name: "srv", transport: "http", url: "https://example.org/mcp" }]);
    }
  });

  it("省略 options 时 MCP 跟设置里已启用的那批，技能按全量（undefined）带入", async () => {
    const settings = useSettingsStore();
    settings.setMcpServerEnabled("deepwiki", true);

    const cowork = useCoworkStore();
    const failure = await cowork.startRun("默认工具面", members());
    expect(failure).toBeNull();
    expect(h.isolateForRun).toHaveBeenCalledWith("/src/ws", { skills: undefined });
    for (const call of h.openSession.mock.calls) {
      expect(call[2]).toEqual([{ name: "deepwiki", transport: "http", url: "https://mcp.deepwiki.com/mcp" }]);
    }
  });

  it("空 skills 选择表示一个都不带（与 undefined 的全量语义区分）", async () => {
    const cowork = useCoworkStore();
    await cowork.startRun("不带技能", members(), [], { skills: [] });
    expect(h.isolateForRun).toHaveBeenCalledWith("/src/ws", { skills: [] });
  });
});

describe("git 集成：队友产出的提交", () => {
  it("起跑记录基线分支与提交，之后新增的提交标 fromRun", async () => {
    const c1 = {
      hash: "aaa",
      shortHash: "aaa",
      author: "Leader",
      email: "l@x",
      timestamp: "2026-01-01T00:00:00Z",
      subject: "init",
      refs: "",
    };
    const c2 = {
      hash: "bbb",
      shortHash: "bbb",
      author: "Builder",
      email: "b@x",
      timestamp: "2026-01-01T00:05:00Z",
      subject: "feat",
      refs: "",
    };
    h.git.log.mockResolvedValueOnce([c1]);

    const cowork = useCoworkStore();
    await cowork.startRun("提交协作", members());

    expect(cowork.runBranch).toBe("greywork/demo");
    expect(cowork.commitsAvailable).toBe(true);
    expect(cowork.commitViews.map((c) => [c.hash, c.fromRun])).toEqual([["aaa", false]]);

    // 队友提交后刷新：新增的 bbb 标 fromRun，基线的 aaa 仍不算本轮
    h.git.log.mockResolvedValueOnce([c2, c1]);
    await cowork.refreshCommits();
    expect(cowork.commitViews.map((c) => [c.hash, c.fromRun])).toEqual([
      ["bbb", true],
      ["aaa", false],
    ]);
  });

  it("非 git 工作区：提交面板整段不可用，协作照常起跑", async () => {
    h.git.currentBranch.mockRejectedValue(new Error("not a git repository"));

    const cowork = useCoworkStore();
    const failure = await cowork.startRun("非 git 协作", members());
    expect(failure).toBeNull();
    expect(cowork.status).toBe("running");
    expect(cowork.commitsAvailable).toBe(false);
  });

  it("按需展开提交 diff 后缓存一次", async () => {
    const c1 = {
      hash: "aaa",
      shortHash: "aaa",
      author: "Leader",
      email: "l@x",
      timestamp: "2026-01-01T00:00:00Z",
      subject: "init",
      refs: "",
    };
    h.git.log.mockResolvedValue([c1]);

    const cowork = useCoworkStore();
    await cowork.startRun("看 diff", members());

    await cowork.loadCommitDiff("aaa");
    expect(h.git.show).toHaveBeenCalledWith("aaa");
    expect(cowork.commitDiffCache["aaa"]).toBe("diff --git a b");

    // 再展开一次不再打 IPC
    await cowork.loadCommitDiff("aaa");
    expect(h.git.show).toHaveBeenCalledTimes(1);
  });
});
