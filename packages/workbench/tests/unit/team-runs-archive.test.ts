/**
 * 编排运行存档（P3）：桌面接管并入 runs + 结束自动入档双写。
 *
 * - 库已接管（db_team_runs_load 返回存档）→ hydrate 后历史并入 runs 列表；
 * - 运行结束（fallback mock 管线全程）→ archiveRun 入档并 db_team_runs_sync；
 * - 浏览器态（无后端）→ 存档落 localStorage 缓存。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { AcpEventEnvelope } from "@greywork/acp";

const h = vi.hoisted(() => ({
  startAgent: vi.fn(),
  openSession: vi.fn(),
  setSessionConfig: vi.fn(),
  prompt: vi.fn(),
  respondPermission: vi.fn(),
  stop: vi.fn(),
  isAvailable: vi.fn(() => true),
  homeDir: vi.fn<() => Promise<string | null>>(() => Promise.resolve("/home/test")),
  listener: null as ((event: AcpEventEnvelope) => void) | null,
}));

vi.mock("@greywork/acp", () => ({
  createAcpClient: () =>
    ({
      isAvailable: () => h.isAvailable(),
      startAgent: (cmd: string, tier: string) => h.startAgent(cmd, tier),
      openSession: (handle: number, cwd: string) => h.openSession(handle, cwd),
      setSessionConfig: (handle: number, configId: string, value: string | boolean) => h.setSessionConfig(handle, configId, value),
      setPermissionTier: () => Promise.resolve(),
      prompt: (handle: number, text: string) => h.prompt(handle, text),
      stop: (handle: number, turnId?: number) => h.stop(handle, turnId),
      respondPermission: (requestId: number, optionId: string | null) => h.respondPermission(requestId, optionId),
      onEvent: (listener: (event: AcpEventEnvelope) => void) => {
        h.listener = listener;
        return Promise.resolve(() => undefined);
      },
    }) as never,
  desktopHomeDir: () => h.homeDir(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked((await import("@tauri-apps/api/core")).invoke);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useAgentStore } from "@/stores/agent";

const storageHolder = globalThis as { localStorage?: Storage };

function installLocalStorage(): void {
  const store = new Map<string, string>();
  storageHolder.localStorage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(key, String(value)),
  };
}

/** 桌面态 invoke 分派：仅 db_team_runs_* 有真值，其余后端快照按空处理。 */
function installInvoke(teamLoad: unknown): void {
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "db_team_runs_load":
        return Promise.resolve(teamLoad);
      case "db_settings_load":
      case "db_sessions_load":
      case "db_automations_load":
        return Promise.resolve(null);
      case "db_team_runs_sync":
      case "db_settings_sync":
      case "db_sessions_sync":
      case "db_automations_sync":
        return Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  });
}

const archivedRun = {
  id: "run-hist-1",
  goal: "历史目标",
  status: "done",
  subtasks: [{ id: "sub-h1", role: "builder", prompt: "历史任务", status: "done" }],
  createdAt: 1_000,
  finishedAt: 2_000,
};

describe("agent 编排存档（浏览器态：localStorage 缓存）", () => {
  beforeEach(() => {
    installLocalStorage();
    vi.useFakeTimers();
    setActivePinia(createPinia());
    h.isAvailable.mockImplementation(() => false); // 走 fallback mock 编排
    h.listener = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete storageHolder.localStorage;
    vi.clearAllMocks();
  });

  it("运行结束自动入档并写 localStorage 缓存", async () => {
    const agentStore = useAgentStore();
    expect(agentStore.runsHydrated).toBeNull(); // 浏览器态无后端

    await agentStore.dispatchRun("生成一份演示方案");
    expect(agentStore.runs[0]?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(2_000); // fallback mock 全程走完

    const archived = agentStore.runs.find((run) => run.id === agentStore.runs[0]?.id);
    expect(archived?.status).toBe("done");
    const cached = JSON.parse(localStorage.getItem("greywork.agent-runs") ?? "{}");
    expect(Array.isArray(cached.runs)).toBe(true);
    expect(cached.runs.some((run: { id: string }) => run.id === archived?.id)).toBe(true);
  });
});

describe("maybeOrchestrate 意图识别", () => {
  beforeEach(() => {
    installLocalStorage();
    vi.useFakeTimers();
    setActivePinia(createPinia());
    h.isAvailable.mockImplementation(() => false);
    h.listener = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete storageHolder.localStorage;
    vi.clearAllMocks();
  });

  it("「自动执行」前缀触发编排并返回 true", async () => {
    const agentStore = useAgentStore();
    const started = agentStore.maybeOrchestrate("自动执行：生成一份日报");
    expect(started).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    const run = agentStore.runs[0];
    expect(run?.status).toBe("done");
    expect(run?.subtasks.length).toBeGreaterThanOrEqual(2);
  });

  it("「编排」前缀同样触发（无冒号）", () => {
    const agentStore = useAgentStore();
    expect(agentStore.maybeOrchestrate("编排整理项目状态")).toBe(true);
    expect(agentStore.runs[0]?.goal).toBe("整理项目状态");
  });

  it("普通输入不触发，返回 false", () => {
    const agentStore = useAgentStore();
    expect(agentStore.maybeOrchestrate("生成一份日报")).toBe(false);
    expect(agentStore.runs).toHaveLength(0);
  });
});

describe("agent 编排存档（桌面态：SQLite 真源）", () => {
  beforeEach(() => {
    installLocalStorage();
    vi.useFakeTimers();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    setActivePinia(createPinia());
    h.isAvailable.mockImplementation(() => false);
    h.listener = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete storageHolder.localStorage;
    vi.clearAllMocks();
  });

  it("库已接管：hydrate 后历史并入 runs（活跃之后）", async () => {
    installInvoke([{ id: "run-hist-1", payload: archivedRun }]);
    const agentStore = useAgentStore();
    await agentStore.runsHydrated;

    expect(agentStore.runs.some((run) => run.id === "run-hist-1")).toBe(true);
    const history = agentStore.runs.find((run) => run.id === "run-hist-1");
    expect(history?.status).toBe("done");
    expect(history?.subtasks[0]?.role).toBe("builder");
  });

  it("库未接管：空存档首落库（写接管标记）", async () => {
    installInvoke(null);
    const agentStore = useAgentStore();
    await agentStore.runsHydrated;

    expect(invokeMock).toHaveBeenCalledWith("db_team_runs_sync", expect.objectContaining({ runs: [] }));
  });

  it("运行结束后入档并同步回库（形状含 payload 全文）", async () => {
    installInvoke(null);
    const agentStore = useAgentStore();
    await agentStore.runsHydrated;

    await agentStore.dispatchRun("生成一份演示方案");
    await vi.advanceTimersByTimeAsync(2_000);

    const syncCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "db_team_runs_sync");
    expect(syncCalls.length).toBeGreaterThanOrEqual(2); // 首落库空存档 + 本次入档
    const syncCall = syncCalls[syncCalls.length - 1];
    const runs = (syncCall?.[1] as { runs: Array<{ id: string; payload: unknown }> }).runs;
    expect(runs.length).toBe(1);
    expect(runs[0].payload).toMatchObject({ status: "done" });
  });
});
