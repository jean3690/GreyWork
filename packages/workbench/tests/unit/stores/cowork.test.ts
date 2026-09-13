// Cowork 协作运行接线契约：成员位各自会话/ACP 进程、按 sessionId 分流、指令驱动的下一跳派发。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { AcpEventEnvelope } from "@greywork/acp";

const h = vi.hoisted(() => ({
  startAgent: vi.fn(),
  openSession: vi.fn(),
  prompt: vi.fn(),
  stop: vi.fn(),
  isAvailable: vi.fn(() => true),
  homeDir: vi.fn<() => Promise<string | null>>(() => Promise.resolve("/home/test")),
  listener: null as ((event: AcpEventEnvelope) => void) | null,
}));

vi.mock("@greywork/acp", () => ({
  createAcpClient: () =>
    ({
      isAvailable: () => h.isAvailable(),
      startAgent: (cmd: string, tier: string, sandbox?: string, workspace?: string | null) => h.startAgent(cmd, tier, sandbox, workspace),
      openSession: (handle: number, cwd: string, mcpServers?: unknown) => h.openSession(handle, cwd, mcpServers),
      setSessionConfig: vi.fn(),
      setPermissionTier: vi.fn(),
      probeMcp: vi.fn(),
      prompt: (handle: number, text: string) => h.prompt(handle, text),
      stop: (handle: number, turnId?: number) => h.stop(handle, turnId),
      respondPermission: vi.fn(),
      onEvent: (listener: (event: AcpEventEnvelope) => void) => {
        h.listener = listener;
        return Promise.resolve(() => undefined);
      },
    }) as never,
  desktopHomeDir: () => h.homeDir(),
}));
vi.mock("@/lib/workspace-dir", () => ({ resolveWorkspaceDir: () => h.homeDir() }));

import { useChatStore } from "@/stores/chat";
import { useAgentStore } from "@/stores/agent";
import { useSettingsStore } from "@/stores/settings";
import { useCoworkStore } from "@/stores/cowork";
import { useSessionStore } from "@/stores/session";

const storageHolder = globalThis as { localStorage?: Storage };

/** node 环境注入内存 localStorage（会话 store 落盘走 createJsonStorage）。 */
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

function emit(event: AcpEventEnvelope): void {
  expect(h.listener).not.toBeNull();
  h.listener?.(event);
}

/** 两位成员：Leader（handle 1 / s-1）、Builder（handle 2 / s-2）。 */
async function startPair() {
  let handleSeq = 0;
  h.startAgent.mockImplementation(() => {
    handleSeq += 1;
    return Promise.resolve(handleSeq);
  });
  h.openSession.mockImplementation((handle: number) => Promise.resolve({ sessionId: `s-${handle}`, configOptions: [] }));
  h.prompt.mockResolvedValue({ turnId: 1 });
  const cowork = useCoworkStore();
  const failure = await cowork.startRun("上线登录功能", [
    { name: "Leader", role: "leader" },
    { name: "Builder", role: "teammate" },
  ]);
  expect(failure).toBeNull();
  return cowork;
}

const fence = (ops: unknown): string => `\`\`\`cowork\n${JSON.stringify(ops)}\n\`\`\``;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  injectStorage();
  h.isAvailable.mockImplementation(() => true);
  h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
  h.listener = null;
});

describe("startRun", () => {
  it("每个成员位一个会话 + 一个 ACP 进程，只有 leader 先拿到角色 prompt", async () => {
    const cowork = await startPair();
    const sessionStore = useSessionStore();

    expect(h.startAgent).toHaveBeenCalledTimes(2);
    expect(h.openSession).toHaveBeenCalledTimes(2);
    // 会话列表里还有既有/演示会话，只断言这两个成员位的会话真实存在
    const ids = sessionStore.sessions.map((session) => session.id);
    for (const slot of cowork.slots) expect(ids).toContain(slot.threadId);
    expect(cowork.slots.map((slot) => slot.name)).toEqual(["Leader", "Builder"]);
    // 成员位的会话互不复用
    expect(new Set(cowork.slots.map((slot) => slot.threadId)).size).toBe(2);

    expect(h.prompt).toHaveBeenCalledTimes(1);
    const [handle, prompt] = h.prompt.mock.calls[0] as [number, string];
    expect(handle).toBe(1);
    expect(prompt).toContain("你是团队 leader");
    expect(prompt).toContain("上线登录功能");
    expect(cowork.status).toBe("running");
  });

  it("leader 的会话被置为前台，便于用户直接对它说话", async () => {
    const cowork = await startPair();
    const sessionStore = useSessionStore();
    expect(sessionStore.activeSessionId).toBe(cowork.slots[0]!.threadId);
  });

  it("启用的 MCP 服务器随每个成员位的会话一起声明给 agent", async () => {
    const settings = useSettingsStore();
    settings.setMcpServerEnabled("deepwiki", true);

    await startPair();

    expect(h.openSession).toHaveBeenCalledTimes(2);
    for (const call of h.openSession.mock.calls) {
      expect(call[2]).toEqual([{ name: "deepwiki", transport: "http", url: "https://mcp.deepwiki.com/mcp" }]);
    }
  });

  it("teammate 带 specialty 时透传到 slot 视图；leader 传了 specialty 被忽略", async () => {
    let handleSeq = 0;
    h.startAgent.mockImplementation(() => Promise.resolve(++handleSeq));
    h.openSession.mockImplementation((handle: number) => Promise.resolve({ sessionId: `s-${handle}`, configOptions: [] }));
    h.prompt.mockResolvedValue({ turnId: 1 });
    const cowork = useCoworkStore();
    const failure = await cowork.startRun("目标", [
      { name: "Leader", role: "leader", specialty: "reviewer" },
      { name: "Builder", role: "teammate", specialty: "builder" },
      { name: "Searcher", role: "teammate" },
    ]);
    expect(failure).toBeNull();

    const leader = cowork.slots.find((slot) => slot.name === "Leader");
    const builder = cowork.slots.find((slot) => slot.name === "Builder");
    const searcher = cowork.slots.find((slot) => slot.name === "Searcher");
    expect(leader?.specialty).toBeUndefined();
    expect(builder?.specialty).toBe("builder");
    expect(searcher?.specialty).toBeUndefined();
  });

  it("传输不可用时不起进程，返回错误文案", async () => {
    h.isAvailable.mockImplementation(() => false);
    const cowork = useCoworkStore();
    const failure = await cowork.startRun("目标", [{ name: "Leader", role: "leader" }]);
    expect(failure).toBeTruthy();
    expect(h.startAgent).not.toHaveBeenCalled();
    expect(cowork.status).toBeNull();
  });

  it("必须有且只有一位 leader，且已有运行时拒绝再开", async () => {
    const cowork = useCoworkStore();
    expect(await cowork.startRun("目标", [{ name: "A", role: "teammate" }])).toBeTruthy();
    expect(
      await cowork.startRun("目标", [
        { name: "A", role: "leader" },
        { name: "B", role: "leader" },
      ]),
    ).toBeTruthy();
    expect(h.startAgent).not.toHaveBeenCalled();

    await startPair();
    expect(await cowork.startRun("另一个目标", [{ name: "Leader", role: "leader" }])).toBeTruthy();
    expect(h.startAgent).toHaveBeenCalledTimes(2);
  });
});

describe("宿主事件分流", () => {
  it("chunk 按 camelCase sessionId 落到对应成员位的会话，而不是全局支架", async () => {
    const cowork = await startPair();
    const chat = useChatStore();
    const leaderThread = cowork.slots[0]!.threadId;
    const builderThread = cowork.slots[1]!.threadId;

    emit({
      kind: "session-update",
      payload: { sessionId: "s-1", update: { sessionUpdate: "agent_message_chunk", content: { text: "先拆解一下。" } } },
    });
    chat.flushPendingContent();

    const leaderMessages = chat.threads[leaderThread] ?? [];
    const assistant = leaderMessages.filter((message) => message.role === "assistant").at(-1);
    expect(assistant?.content).toBe("先拆解一下。");
    expect(assistant?.acp).toBe("Leader");
    // 投递的信件在会话里留了一条可审计的 system 记录
    expect(leaderMessages.some((message) => message.role === "system")).toBe(true);
    // Builder 尚未被派活，不该有任何流入
    expect((chat.threads[builderThread] ?? []).length).toBe(0);
  });

  it("未知 sessionId 的事件被忽略，不污染任何会话", async () => {
    const cowork = await startPair();
    const chat = useChatStore();
    const leaderThread = cowork.slots[0]!.threadId;
    const before = (chat.threads[leaderThread] ?? []).length;

    emit({
      kind: "session-update",
      payload: { sessionId: "s-999", update: { sessionUpdate: "agent_message_chunk", content: { text: "野消息" } } },
    });
    chat.flushPendingContent();

    expect((chat.threads[leaderThread] ?? []).length).toBe(before);
  });

  it("prompt-done 解析协作指令并派发下一跳：leader 建任务 → Builder 被唤醒", async () => {
    const cowork = await startPair();
    const chat = useChatStore();

    emit({
      kind: "session-update",
      payload: {
        sessionId: "s-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: `安排如下。\n${fence([{ op: "task", subject: "实现登录", owner: "Builder" }])}` },
        },
      },
    });
    chat.flushPendingContent();
    emit({ kind: "prompt-done", payload: { handle: 1, turnId: 1 } });
    await Promise.resolve();

    expect(h.prompt).toHaveBeenCalledTimes(2);
    const [handle, prompt] = h.prompt.mock.calls[1] as [number, string];
    expect(handle).toBe(2);
    expect(prompt).toContain("你是团队成员 Builder");
    expect(prompt).toContain("实现登录");
    expect(cowork.tasks[0]).toMatchObject({ subject: "实现登录", ownerName: "Builder", status: "pending" });
    expect(cowork.slots[1]!.wake).toBe("running");
  });

  it("成员回合失败（prompt-done 带 error）：支架落失败文案而非「无文本输出」", async () => {
    const cowork = await startPair();
    const chat = useChatStore();
    const leaderThread = cowork.slots[0]!.threadId;

    emit({ kind: "prompt-done", payload: { handle: 1, turnId: 1, error: "backend down" } });
    await Promise.resolve();

    const leaderMessages = chat.threads[leaderThread] ?? [];
    const scaffold = leaderMessages.filter((message) => message.role === "assistant").at(-1);
    expect(scaffold?.content).toBe("[LLM 调用失败] backend down");
    expect(leaderMessages.some((message) => message.content === "（本次回合无文本输出）")).toBe(false);
  });

  it("空闲成员位收到 stopped 是噪声，不标记失败也不惊动 leader", async () => {
    const cowork = await startPair();
    emit({ kind: "prompt-done", payload: { handle: 1, turnId: 1 } });
    await Promise.resolve();
    const before = h.prompt.mock.calls.length;

    emit({ kind: "stopped", payload: { handle: 2 } });

    expect(cowork.slots[1]!.status).toBe("pending");
    expect(h.prompt.mock.calls.length).toBe(before);
    // leader 空回合后没有未读、没有在跑回合 → 运行到达静止
    expect(cowork.status).toBe("done");
  });

  it("在跑的成员位被中止：标记 failed 并把失败汇总给 leader", async () => {
    const cowork = await startPair();
    emit({
      kind: "session-update",
      payload: {
        sessionId: "s-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: fence([{ op: "task", subject: "实现登录", owner: "Builder" }]) },
        },
      },
    });
    const chat = useChatStore();
    chat.flushPendingContent();
    emit({ kind: "prompt-done", payload: { handle: 1, turnId: 1 } });
    await Promise.resolve();
    expect(h.prompt).toHaveBeenCalledTimes(2);

    emit({ kind: "stopped", payload: { handle: 2 } });
    await Promise.resolve();

    expect(cowork.slots[1]!.status).toBe("failed");
    expect(h.prompt).toHaveBeenCalledTimes(3);
    const [handle, prompt] = h.prompt.mock.calls[2] as [number, string];
    expect(handle).toBe(1);
    expect(prompt).toContain("回合失败");
  });
});

describe("stopRun", () => {
  it("取消运行并回收全部 ACP 进程", async () => {
    const cowork = await startPair();
    await cowork.stopRun();

    expect(h.stop).toHaveBeenCalledTimes(2);
    expect(h.stop.mock.calls.map((call) => call[0]).sort()).toEqual([1, 2]);
    expect(cowork.status).toBe("cancelled");
  });
});

describe("成员各自指定 ACP 后端", () => {
  /** 默认目录里首个后端即全局选中；再挂一个自配后端，作为「某位成员的专属后端」。 */
  async function withExtraProvider() {
    const agent = useAgentStore();
    expect(agent.addAgentProvider("Second Agent", "second-agent acp")).toBeNull();
    const custom = agent.agentProviders.find((provider) => provider.name === "Second Agent")!;
    let handleSeq = 0;
    h.startAgent.mockImplementation(() => Promise.resolve(++handleSeq));
    h.openSession.mockImplementation((handle: number) => Promise.resolve({ sessionId: `s-${handle}`, configOptions: [] }));
    h.prompt.mockResolvedValue({ turnId: 1 });
    return { agent, custom };
  }

  it("按成员位的 providerId 分别起进程；未指定的跟随全局选中", async () => {
    const { agent, custom } = await withExtraProvider();
    const globalCommand = agent.agentProviders.find((provider) => provider.id === agent.selectedProviderId)!.command;

    const cowork = useCoworkStore();
    const failure = await cowork.startRun("目标", [
      { name: "Leader", role: "leader" },
      { name: "Builder", role: "teammate", providerId: custom.id },
    ]);
    expect(failure).toBeNull();

    expect(h.startAgent).toHaveBeenCalledTimes(2);
    expect(h.startAgent.mock.calls.map((call) => call[0])).toEqual([globalCommand, "second-agent acp"]);
  });

  it("成员指向不存在的后端：先校验再起进程，一个都不起", async () => {
    await withExtraProvider();
    const cowork = useCoworkStore();
    const failure = await cowork.startRun("目标", [
      { name: "Leader", role: "leader" },
      { name: "Builder", role: "teammate", providerId: "custom-鬼影" },
    ]);

    expect(failure).toBeTruthy();
    expect(h.startAgent).not.toHaveBeenCalled();
    expect(cowork.status).toBeNull();
  });
});
