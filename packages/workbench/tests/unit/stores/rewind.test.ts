// 会话 + 文件一起回退（A3b）：
// - 普通回合在**起点**记一次工作区快照，ref 挂到 user 消息上（仅 worktree 档位）；
// - rewindTo 硬恢复工作区 + 截断消息流（丢弃该 user 消息及其后全部）+ 清 ACP 绑定。
// 宿主经 host-ipc 的 invoke 打桩；ACP 客户端照 turn-artifacts 的套路打桩。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type * as HostIpc from "@greywork/host-ipc";

const h = vi.hoisted(() => ({
  startAgent: vi.fn(),
  openSession: vi.fn(),
  loadSession: vi.fn(),
  setSessionConfig: vi.fn(),
  setPermissionTier: vi.fn(),
  prompt: vi.fn(),
  probeMcp: vi.fn(),
  respondPermission: vi.fn(),
  stop: vi.fn(),
  isAvailable: vi.fn(() => true),
  listener: null as ((event: { kind: string; payload?: unknown }) => void) | null,
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
}));

vi.mock("@greywork/acp", () => ({
  createAcpClient: () =>
    ({
      isAvailable: () => h.isAvailable(),
      startAgent: (cmd: string, tier: string) => h.startAgent(cmd, tier),
      openSession: (handle: number, cwd: string, mcpServers?: unknown) => h.openSession(handle, cwd, mcpServers),
      loadSession: (handle: number, cwd: string, sessionId: string, mcpServers?: unknown) =>
        h.loadSession(handle, cwd, sessionId, mcpServers),
      probeMcp: (config: unknown) => h.probeMcp(config),
      setSessionConfig: (handle: number, configId: string, value: string | boolean) => h.setSessionConfig(handle, configId, value),
      setPermissionTier: (handle: number, tier: string) => h.setPermissionTier(handle, tier),
      prompt: (handle: number, text: string) => h.prompt(handle, text),
      stop: (handle: number, turnId?: number) => h.stop(handle, turnId),
      respondPermission: (requestId: number, optionId: string | null) => h.respondPermission(requestId, optionId),
      onEvent: (listener: (event: { kind: string; payload?: unknown }) => void) => {
        h.listener = listener;
        return Promise.resolve(() => undefined);
      },
    }) as never,
  desktopHomeDir: () => Promise.resolve("/home/test"),
}));

// 保留真实导出，只把「是否有宿主命令」与 invoke 换成可控打桩。
vi.mock("@greywork/host-ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof HostIpc>();
  return { ...actual, hasHostCommands: () => true, invoke: h.invoke };
});

import { useAgentStore } from "@/stores/agent";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";

const WT_ROOT = "/home/test/.greyWork/worktrees/repo-abc";
const SNAP_REF = "refs/greywork/snap/abc";

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

function emit(event: { kind: string; payload?: unknown }): void {
  expect(h.listener).not.toBeNull();
  h.listener?.(event);
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  injectStorage();
  useSettingsStore().workspaceDir = "/home/test";
  useSettingsStore().runMode = "worktree";
  h.isAvailable.mockImplementation(() => true);
  h.listener = null;
  h.startAgent.mockResolvedValue(7);
  h.openSession.mockResolvedValue({ sessionId: "s1", configOptions: [] });
  h.prompt.mockResolvedValue({ turnId: 1 });
  h.invoke.mockImplementation((cmd: string) => {
    if (cmd === "worktree_provision") return Promise.resolve({ root: WT_ROOT, kind: "git", source: "/home/test" });
    if (cmd === "worktree_snapshot") return Promise.resolve(SNAP_REF);
    return Promise.resolve(undefined);
  });
});

describe("回合起点快照", () => {
  it("普通回合在起点记快照，ref 挂到 user 消息上", async () => {
    const record = useSessionStore().createSession(null, "回退");
    await useAgentStore().dispatchToAcp("改一下接口");

    const user = record.messages.find((message) => message.role === "user");
    expect(user?.snapshotRef).toBe(SNAP_REF);
    expect(h.invoke).toHaveBeenCalledWith("worktree_snapshot", { root: WT_ROOT });
  });

  it("非 worktree 档位不记快照", async () => {
    useSettingsStore().runMode = "local";
    const record = useSessionStore().createSession(null, "本地");
    await useAgentStore().dispatchToAcp("你好");

    const user = record.messages.find((message) => message.role === "user");
    expect(user?.snapshotRef).toBeUndefined();
    expect(h.invoke).not.toHaveBeenCalledWith("worktree_snapshot", expect.anything());
  });

  it("宿主快照失败只告警，不阻断回合", async () => {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "worktree_provision") return Promise.resolve({ root: WT_ROOT, kind: "copy", source: "/home/test" });
      if (cmd === "worktree_snapshot") return Promise.reject(new Error("只有 git 隔离快照支持快照与回退"));
      return Promise.resolve(undefined);
    });
    const record = useSessionStore().createSession(null, "快照失败");
    await useAgentStore().dispatchToAcp("照常发出去");

    // 回合照常派发（prompt 被调用），只是该消息没有可回退的快照。
    expect(h.prompt).toHaveBeenCalled();
    const user = record.messages.find((message) => message.role === "user");
    expect(user?.snapshotRef).toBeUndefined();
  });
});

describe("rewindTo", () => {
  /** 跑两轮并各自收尾（清 busy），返回第一轮 user 消息与线程 id。 */
  async function twoTurns() {
    const record = useSessionStore().createSession(null, "两轮");
    const agent = useAgentStore();
    await agent.dispatchToAcp("第一轮");
    const firstUser = record.messages.find((message) => message.role === "user");
    expect(firstUser).toBeDefined();
    emit({ kind: "prompt-done", payload: { turnId: 1, response: {} } });
    await agent.dispatchToAcp("第二轮");
    emit({ kind: "prompt-done", payload: { turnId: 2, response: {} } });
    return { record, agent, firstUser: firstUser! };
  }

  it("硬恢复工作区 + 截断消息 + 清 ACP 绑定", async () => {
    const { record, agent, firstUser } = await twoTurns();
    expect(record.messages).toHaveLength(4);
    expect(record.acp).toBeDefined();

    h.invoke.mockClear();
    const error = await agent.rewindTo(record.id, firstUser.id);

    expect(error).toBeNull();
    expect(h.invoke).toHaveBeenCalledWith("worktree_restore", { root: WT_ROOT, reference: SNAP_REF });
    // 丢弃第一轮 user 及其后全部
    expect(record.messages).toHaveLength(0);
    // agent 上下文不可回退：绑定被清（下个回合开新会话）
    expect(record.acp).toBeUndefined();
  });

  it("没有快照 ref 的消息不可回退", async () => {
    const record = useSessionStore().createSession(null, "无快照");
    record.messages.push({ id: "u1", role: "user", content: "x", ts: Date.now() });

    h.invoke.mockClear();
    const error = await useAgentStore().rewindTo(record.id, "u1");

    expect(error).toBeTruthy();
    expect(h.invoke).not.toHaveBeenCalledWith("worktree_restore", expect.anything());
    expect(record.messages).toHaveLength(1);
  });

  it("回合进行中不可回退", async () => {
    const record = useSessionStore().createSession(null, "忙");
    const agent = useAgentStore();
    await agent.dispatchToAcp("第一轮");
    const firstUser = record.messages.find((message) => message.role === "user")!;

    // 未 emit prompt-done：acpBusy 仍为 true。
    const error = await agent.rewindTo(record.id, firstUser.id);
    expect(error).toBeTruthy();
    expect(record.messages).toHaveLength(2);
  });
});
