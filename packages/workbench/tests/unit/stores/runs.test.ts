// 编排域（useRunsStore）：planner 分解 → 子任务并行派发 → replan 调整。
// 事件流经 agent store 监听器 + 桥路由回本域；harness 与 agent.test.ts 共用（单槽监听器由 dispatchRun 内部触发注册）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { AcpEventEnvelope } from "@greywork/acp";

const h = vi.hoisted(() => ({
  startAgent: vi.fn(),
  openSession: vi.fn(),
  setSessionConfig: vi.fn(),
  setPermissionTier: vi.fn(),
  prompt: vi.fn(),
  probeMcp: vi.fn(),
  respondPermission: vi.fn(),
  stop: vi.fn(),
  isAvailable: vi.fn(() => true),
  homeDir: vi.fn<() => Promise<string | null>>(() => Promise.resolve("/home/test")),
  /** 最近一次注册的事件监听（模拟宿主事件源）。 */
  listener: null as ((event: AcpEventEnvelope) => void) | null,
}));

vi.mock("@greywork/acp", () => ({
  createAcpClient: () =>
    ({
      isAvailable: () => h.isAvailable(),
      startAgent: (cmd: string, tier: string) => h.startAgent(cmd, tier),
      openSession: (handle: number, cwd: string, mcpServers?: unknown) => h.openSession(handle, cwd, mcpServers),
      probeMcp: (config: unknown) => h.probeMcp(config),
      setSessionConfig: (handle: number, configId: string, value: string | boolean) => h.setSessionConfig(handle, configId, value),
      setPermissionTier: (handle: number, tier: string) => h.setPermissionTier(handle, tier),
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

import { useRunsStore } from "@/stores/runs";
import { useChatStore } from "@/stores/chat";

function emit(event: AcpEventEnvelope): void {
  expect(h.listener).not.toBeNull();
  h.listener?.(event);
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  h.isAvailable.mockImplementation(() => true);
  h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
  h.listener = null;
});

describe("并行编排（dispatchRun）", () => {
  it("无 ACP 后端时走演示降级：两个 mock 子任务顺序推进至 done", async () => {
    h.isAvailable.mockImplementation(() => false);
    const runsStore = useRunsStore();

    void runsStore.dispatchRun("梳理本周改动");

    await vi.waitFor(() => expect(runsStore.runs[0]?.status).toBe("done"), { timeout: 3000 });
    expect(runsStore.runs[0]?.subtasks).toHaveLength(2);
    expect(runsStore.runs[0]?.subtasks.every((sub) => sub.status === "done")).toBe(true);
    expect(runsStore.runs[0]?.finishedAt).toBeTypeOf("number");
  });

  it("planner 回合解析 JSON 计划后，子任务按 maxParallel 并行派发并逐个完成", async () => {
    let handleSeq = 0;
    let sessionSeq = 0;
    h.startAgent.mockImplementation(() => Promise.resolve(++handleSeq));
    h.openSession.mockImplementation(() => Promise.resolve({ sessionId: `session-${++sessionSeq}`, configOptions: [] }));
    h.prompt.mockImplementation(() => new Promise<unknown>(() => undefined));
    const runsStore = useRunsStore();
    const chat = useChatStore();

    void runsStore.dispatchRun("分析客流数据");

    // planner 回合：全局 session（session-1 / handle 1）流式输出 JSON 计划
    await vi.waitFor(() => {
      expect(h.prompt).toHaveBeenCalledWith(1, expect.stringContaining("你是任务编排器"));
    });
    emit({
      kind: "session-update",
      payload: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: '[{"role":"researcher","prompt":"抓取数据"},{"role":"geo-analyst","prompt":"空间聚类"}]' },
        },
      },
    });
    chat.flushPendingContent();
    emit({ kind: "prompt-done", payload: { handle: 1, response: {} } });

    // 计划解析成功 → 两个子任务并行派发（handle 2/3，session 2/3）
    await vi.waitFor(() => {
      expect(h.startAgent).toHaveBeenCalledTimes(3); // 1 planner + 2 subtask
      expect(runsStore.runs[0]?.status).toBe("running");
      expect(runsStore.runs[0]?.subtasks).toHaveLength(2);
    });
    expect(h.prompt).toHaveBeenCalledTimes(3);

    // 子任务 1 流式输出并完成
    emit({
      kind: "session-update",
      payload: { session_id: "session-2", update: { sessionUpdate: "agent_message_chunk", content: { text: "已抓取 3 条" } } },
    });
    chat.flushPendingContent();
    emit({ kind: "prompt-done", payload: { handle: 2, response: {} } });
    expect(runsStore.runs[0]?.subtasks[0]?.status).toBe("done");
    expect(runsStore.runs[0]?.status).toBe("running"); // 子任务 2 仍在跑

    // 子任务 2 完成 → run done
    emit({
      kind: "session-update",
      payload: { session_id: "session-3", update: { sessionUpdate: "agent_message_chunk", content: { text: "聚类完成" } } },
    });
    chat.flushPendingContent();
    emit({ kind: "prompt-done", payload: { handle: 3, response: {} } });
    expect(runsStore.runs[0]?.subtasks.every((sub) => sub.status === "done")).toBe(true);
    expect(runsStore.runs[0]?.status).toBe("done");
  });

  it("planner 未返回有效 JSON 时 run 置 failed，不派发任何子任务", async () => {
    let handleSeq = 0;
    h.startAgent.mockImplementation(() => Promise.resolve(++handleSeq));
    h.openSession.mockImplementation(() => Promise.resolve({ sessionId: "session-1", configOptions: [] }));
    h.prompt.mockImplementation(() => new Promise<unknown>(() => undefined));
    const runsStore = useRunsStore();
    const chat = useChatStore();

    void runsStore.dispatchRun("生成日报");
    await vi.waitFor(() => expect(h.prompt).toHaveBeenCalledTimes(1));

    emit({
      kind: "session-update",
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { text: "抱歉，我无法完成" } } },
    });
    chat.flushPendingContent();
    emit({ kind: "prompt-done", payload: { handle: 1, response: {} } });

    await vi.waitFor(() => expect(runsStore.runs[0]?.status).toBe("failed"));
    expect(runsStore.runs[0]?.subtasks).toHaveLength(0);
    expect(h.startAgent).toHaveBeenCalledTimes(1); // 仅 planner
  });
});

describe("replan（执行中调整计划）", () => {
  /** 建立一次真实链路 run：planner 分解为 2 个子任务并全部完成。 */
  async function setupDoneRun(runsStore: ReturnType<typeof useRunsStore>): Promise<string> {
    let handleSeq = 0;
    let sessionSeq = 0;
    h.startAgent.mockImplementation(() => Promise.resolve(++handleSeq));
    h.openSession.mockImplementation(() => Promise.resolve({ sessionId: `session-${++sessionSeq}`, configOptions: [] }));
    h.prompt.mockImplementation(() => new Promise<unknown>(() => undefined));

    void runsStore.dispatchRun("分析客流数据");
    await vi.waitFor(() => expect(h.prompt).toHaveBeenCalledWith(1, expect.stringContaining("你是任务编排器")));
    emit({
      kind: "session-update",
      payload: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: '[{"role":"researcher","prompt":"抓取数据"},{"role":"geo-analyst","prompt":"空间聚类"}]' },
        },
      },
    });
    const chat = useChatStore();
    chat.flushPendingContent();
    emit({ kind: "prompt-done", payload: { handle: 1, response: {} } });
    await vi.waitFor(() => expect(runsStore.runs[0]?.subtasks).toHaveLength(2));
    // 等待两个子任务各自完成 startAgent/openSession（session 已注册，handle 2/3）
    await vi.waitFor(() => expect(h.startAgent).toHaveBeenCalledTimes(3));
    emit({ kind: "prompt-done", payload: { handle: 2, response: {} } });
    emit({ kind: "prompt-done", payload: { handle: 3, response: {} } });
    await vi.waitFor(() => expect(runsStore.runs[0]?.status).toBe("done"));
    return runsStore.runs[0]?.id ?? "";
  }

  it("cancelSubtask 移除 pending 子任务，run 继续推进", async () => {
    h.isAvailable.mockImplementation(() => false);
    const runsStore = useRunsStore();
    void runsStore.dispatchRun("梳理改动");
    await vi.waitFor(() => expect(runsStore.runs[0]?.subtasks).toHaveLength(2));

    const runId = runsStore.runs[0]?.id ?? "";
    const subId = runsStore.runs[0]?.subtasks[0]?.id ?? "";
    await runsStore.cancelSubtask(runId, subId);

    expect(runsStore.runs[0]?.subtasks).toHaveLength(1);
    await vi.waitFor(() => expect(runsStore.runs[0]?.status).toBe("done"), { timeout: 3000 });
  });

  it("cancelSubtask 取消 running 子任务：停进程并出队，剩余子任务不受影响", async () => {
    const runsStore = useRunsStore();
    const runId = await setupDoneRun(runsStore); // 结束后追加逻辑
    // 追加一个 pending 子任务再取消它（队列出队路径）
    runsStore.addSubtask(runId, "builder", "补做清理");
    await vi.waitFor(() => expect(runsStore.runs[0]?.subtasks).toHaveLength(3));
    const added = runsStore.runs[0]?.subtasks[2];
    await runsStore.cancelSubtask(runId, added?.id ?? "");
    expect(runsStore.runs[0]?.subtasks).toHaveLength(2);
    expect(runsStore.runs[0]?.status).toBe("done");
  });

  it("addSubtask 追加子任务并派发：handle/session 递增、prompt 再次调用", async () => {
    const runsStore = useRunsStore();
    const runId = await setupDoneRun(runsStore);
    const promptsBefore = h.prompt.mock.calls.length;

    runsStore.addSubtask(runId, "builder", "补做清理");

    await vi.waitFor(() => expect(runsStore.runs[0]?.subtasks).toHaveLength(3));
    await vi.waitFor(() => expect(h.prompt.mock.calls.length).toBeGreaterThan(promptsBefore));
    expect(runsStore.runs[0]?.status).toBe("running");

    // 新子任务完成 → run 恢复 done
    await vi.waitFor(() => expect(h.startAgent).toHaveBeenCalledTimes(4)); // 新 session 已注册
    emit({ kind: "prompt-done", payload: { handle: 4, response: {} } });
    await vi.waitFor(() => expect(runsStore.runs[0]?.status).toBe("done"));
  });

  it("retrySubtask 重置失败子任务重新派发，run 恢复 running", async () => {
    const runsStore = useRunsStore();
    const runId = await setupDoneRun(runsStore);
    const promptsBefore = h.prompt.mock.calls.length;

    // 人为置失败，模拟某子任务执行失败
    const target = runsStore.runs[0]?.subtasks[0];
    if (target) target.status = "failed";
    runsStore.retrySubtask(runId, target?.id ?? "");

    expect(runsStore.runs[0]?.status).toBe("running");
    // retry 立即重跑：子任务应很快进入 running 并再次调用 prompt
    await vi.waitFor(() => expect(h.prompt.mock.calls.length).toBeGreaterThan(promptsBefore));
    await vi.waitFor(() => expect(runsStore.runs[0]?.subtasks[0]?.status).toBe("running"));
  });
});
