// ACP 派发 → Chat·Cowork 对话流契约：支架消息入线、chunk 流式续写、权限卡片挂起/裁决。
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  /** 最近一次注册的事件监听（模拟宿主事件源）。 */
  listener: null as ((event: AcpEventEnvelope) => void) | null,
}));

vi.mock("@greywork/acp", () => ({
  createAcpClient: () => ({}) as never,
  desktopHomeDir: () => h.homeDir(),
}));

vi.mock("@greywork/integrations", () => ({
  createAcpAgentAdapter: () => ({
    provider: "acp",
    isAvailable: () => h.isAvailable(),
    startAgent: (cmd: string, tier: string) => h.startAgent(cmd, tier),
    openSession: (handle: number, cwd: string) => h.openSession(handle, cwd),
    setSessionConfig: (handle: number, configId: string, value: string | boolean) => h.setSessionConfig(handle, configId, value),
    prompt: (handle: number, text: string) => h.prompt(handle, text),
    stop: () => h.stop(),
    respondPermission: (requestId: number, optionId: string | null) => h.respondPermission(requestId, optionId),
    onEvent: (listener: (event: AcpEventEnvelope) => void) => {
      h.listener = listener;
      return Promise.resolve(() => undefined);
    },
  }),
}));

import { useAgentStore } from "./agent";
import { useChatStore } from "./chat";

function emit(event: AcpEventEnvelope): void {
  expect(h.listener).not.toBeNull();
  h.listener?.(event);
}

/** TS lib 为 ES2022（无 Promise.withResolvers）：本地 deferred 助手仅测试使用。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  h.isAvailable.mockImplementation(() => true);
  h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
  h.listener = null;
});

describe("dispatchToAcp 写入对话流", () => {
  it("user 消息与 assistant 支架进入当前线程，chunk 流式续写 content", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({
      sessionId: "session-1",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "mock/fast",
          options: [{ value: "mock/fast" }, { value: "mock/slow" }],
        },
      ],
    });
    const turn = deferred<unknown>();
    h.prompt.mockImplementation(() => turn.promise);
    const agentStore = useAgentStore();
    const chat = useChatStore();

    const pending = agentStore.dispatchToAcp("整理本周改动");

    const list = chat.threads[chat.activeThreadId];
    expect(list.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(list[0]?.content).toBe("整理本周改动");
    expect(list[1]?.content).toBe("");
    expect(list[1]?.acp).toBe("OpenCode");
    await vi.waitFor(() => {
      expect(h.startAgent).toHaveBeenCalledTimes(1);
      expect(h.openSession).toHaveBeenCalledWith(7, "/home/test");
      expect(h.prompt).toHaveBeenCalledWith(7, "整理本周改动");
      expect(agentStore.acpBusy).toBe(true);
    });

    emit({
      kind: "session-update",
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { text: "本周共" } } },
    });
    emit({
      kind: "session-update",
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { text: " 5 项改动" } } },
    });
    chat.flushPendingContent();
    expect(list[1]?.content).toBe("本周共 5 项改动");

    emit({
      kind: "permission-auto",
      payload: {
        requestId: 3,
        auto: true,
        chosen: "allow",
        toolCallId: "tc-0",
        kind: "read",
        options: [],
      },
    });
    chat.flushPendingContent();
    expect(list[1]?.content).toContain("宿主自动批准");

    turn.resolve({ stopReason: "end_turn" });
    await pending;
    expect(agentStore.acpBusy).toBe(false);
    expect(chat.llmReady).toBe(false);
  });

  it("会话已存在时复用 handle，不重复启动 agent", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    h.prompt.mockResolvedValue({});
    const agentStore = useAgentStore();

    await agentStore.dispatchToAcp("第一回合");
    await agentStore.dispatchToAcp("第二回合");

    expect(h.startAgent).toHaveBeenCalledTimes(1);
    expect(h.prompt).toHaveBeenCalledTimes(2);
  });

  it("流式续写定位到原线程：切换 activeThreadId 后 chunk 仍写入支架", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    const turn = deferred<unknown>();
    h.prompt.mockImplementation(() => turn.promise);
    const agentStore = useAgentStore();
    const chat = useChatStore();

    const pending = agentStore.dispatchToAcp("第一线程的回合");
    await vi.waitFor(() => expect(agentStore.acpBusy).toBe(true));
    const originThreadId = chat.activeThreadId;
    const originMessages = chat.threads[originThreadId];
    expect(originMessages.at(-1)?.content).toBe("");

    // 流式生成中切到另一线程
    chat.activeThreadId = "other-thread";

    emit({
      kind: "session-update",
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { text: "跨线程 chunk" } } },
    });
    chat.flushPendingContent();
    expect(chat.threads[originThreadId]?.at(-1)?.content).toBe("跨线程 chunk");
    expect(chat.threads["other-thread"] ?? []).toHaveLength(0);

    turn.resolve({});
    await pending;
    expect(agentStore.acpBusy).toBe(false);
  });

  it("无可用 ACP 后端时支架消息落错误文案", async () => {
    h.isAvailable.mockImplementation(() => false);
    const agentStore = useAgentStore();
    const chat = useChatStore();

    await agentStore.dispatchToAcp("试试派发");

    const list = chat.threads[chat.activeThreadId];
    expect(list[1]?.content).toContain("ACP 启动失败");
  });

  it("未选后端 / 工作区不可解析 / 启动异常时落对应文案", async () => {
    const agentStore = useAgentStore();
    const chat = useChatStore();

    agentStore.selectProvider("nope");
    await agentStore.dispatchToAcp("派发到不存在的后端");
    expect(chat.threads[chat.activeThreadId]?.at(-1)?.content).toContain("未选择 ACP 后端");

    agentStore.selectProvider("opencode");
    h.homeDir.mockImplementation(() => Promise.resolve(null));
    await agentStore.dispatchToAcp("工作区不可解析");
    expect(chat.threads[chat.activeThreadId]?.at(-1)?.content).toContain("无法解析工作区目录");

    h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
    h.startAgent.mockRejectedValue(new Error("spawn failed"));
    await agentStore.dispatchToAcp("启动失败");
    expect(chat.threads[chat.activeThreadId]?.at(-1)?.content).toContain("启动失败：Error: spawn failed");
    expect(h.startAgent).toHaveBeenCalledTimes(1);
  });

  it("prompt 拒绝追加错误，stopAcp 转发停止并落停止失败记录", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    const agentStore = useAgentStore();
    const chat = useChatStore();

    const turn = deferred<unknown>();
    h.prompt.mockRejectedValue(new Error("boom"));
    await agentStore.dispatchToAcp("会失败的回合");
    expect(chat.threads[chat.activeThreadId]?.at(-1)?.content).toContain("[ACP 派发失败] boom");

    h.prompt.mockImplementation(() => turn.promise);
    const pending = agentStore.dispatchToAcp("流式回合");
    await vi.waitFor(() => expect(agentStore.acpBusy).toBe(true));
    h.stop.mockRejectedValue(new Error("no handle"));
    await agentStore.stopAcp();
    chat.flushPendingContent();
    expect(chat.threads[chat.activeThreadId]?.at(-1)?.content).toContain("[停止失败] Error: no handle");

    turn.resolve({});
    await pending;
  });
});

describe("权限请求与裁决", () => {
  it("permission-request 挂起卡片，respondPermission 清空并回传宿主", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    h.prompt.mockResolvedValue({});
    const agentStore = useAgentStore();
    await agentStore.dispatchToAcp("需要确认的操作");

    emit({
      kind: "permission-request",
      payload: {
        requestId: 5,
        auto: false,
        chosen: null,
        toolCallId: "tc-1",
        kind: "execute",
        options: [{ optionId: "allow", name: "允许", kind: "allow_once" }],
      },
    });
    expect(agentStore.pendingPermission?.requestId).toBe(5);

    await agentStore.respondPermission("allow");

    expect(agentStore.pendingPermission).toBeNull();
    expect(h.respondPermission).toHaveBeenCalledWith(5, "allow");
  });

  it("回传失败时向流内记录错误", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    const turn = deferred<unknown>();
    h.prompt.mockImplementation(() => turn.promise);
    const agentStore = useAgentStore();
    const chat = useChatStore();
    const pending = agentStore.dispatchToAcp("需要确认的操作");
    await vi.waitFor(() => expect(agentStore.acpBusy).toBe(true));

    emit({
      kind: "permission-request",
      payload: {
        requestId: 6,
        auto: false,
        chosen: null,
        toolCallId: "tc-3",
        kind: "execute",
        options: [{ optionId: "allow", name: "允许", kind: "allow_once" }],
      },
    });
    h.respondPermission.mockRejectedValue(new Error("closed"));
    await agentStore.respondPermission("allow");
    chat.flushPendingContent();
    expect(chat.threads[chat.activeThreadId]?.at(-1)?.content).toContain("[权限回传失败] Error: closed");

    turn.resolve({});
    await pending;
  });

  it("permission-blocked（宿主锚定拦截）向流内追加通知，不打断流", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    const turn = deferred<unknown>();
    h.prompt.mockImplementation(() => turn.promise);
    const agentStore = useAgentStore();
    const chat = useChatStore();
    const pending = agentStore.dispatchToAcp("写文件");
    await vi.waitFor(() => expect(agentStore.acpBusy).toBe(true));

    emit({
      kind: "permission-blocked",
      payload: {
        auto: true,
        chosen: null,
        toolCallId: "tc-4",
        title: "编辑 /etc/passwd",
        kind: "edit",
        reason: "outside-workspace",
        paths: ["/etc/passwd"],
      },
    });
    chat.flushPendingContent();
    expect(chat.threads[chat.activeThreadId]?.at(-1)?.content).toContain("宿主拦截");
    expect(chat.threads[chat.activeThreadId]?.at(-1)?.content).toContain("/etc/passwd");
    expect(agentStore.acpBusy).toBe(true);

    turn.resolve({});
    await pending;
    expect(agentStore.acpBusy).toBe(false);
  });
});
describe("会话配置选择器（session/set_config_option）", () => {
  it("启动会话后暴露 configOptions，setAcpConfig 回写最新选项", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({
      sessionId: "session-1",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "mock/fast",
          options: [
            { value: "mock/fast", name: "Fast" },
            { value: "mock/slow", name: "Slow" },
          ],
        },
      ],
    });
    const latest = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "mock/slow",
        options: [
          { value: "mock/fast", name: "Fast" },
          { value: "mock/slow", name: "Slow" },
        ],
      },
    ];
    h.setSessionConfig.mockResolvedValue(latest);
    const agentStore = useAgentStore();

    await agentStore.dispatchToAcp("先起会话");
    expect(agentStore.acpConfigOptions).toHaveLength(1);
    expect(agentStore.acpConfigOptions[0]?.currentValue).toBe("mock/fast");

    const failure = await agentStore.setAcpConfig("model", "mock/slow");
    expect(failure).toBeNull();
    expect(h.setSessionConfig).toHaveBeenCalledWith(7, "model", "mock/slow");
    expect(agentStore.acpConfigOptions).toEqual(latest);
  });

  it("会话未启动时 setAcpConfig 返回错误文案", async () => {
    const agentStore = useAgentStore();

    expect(await agentStore.setAcpConfig("model", "x")).toContain("会话未启动");
  });

  it("connectAcp 幂等：未连接时启动会话，已连接直接复用", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({
      sessionId: "session-1",
      configOptions: [{ id: "effort", name: "Effort", type: "select", currentValue: "high", options: [{ value: "high" }] }],
    });
    const agentStore = useAgentStore();

    expect(await agentStore.connectAcp()).toBeNull();
    expect(await agentStore.connectAcp()).toBeNull();
    expect(h.startAgent).toHaveBeenCalledTimes(1);
    expect(agentStore.acpConfigOptions).toHaveLength(1);
  });

  it("首页 ACP CLI 入口启用所选 provider，并在切换时停止旧会话", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    h.stop.mockResolvedValue(undefined);
    const agentStore = useAgentStore();

    expect(await agentStore.activateAcpProvider("opencode")).toBeNull();
    expect(agentStore.routeToAcp).toBe(true);
    expect(agentStore.selectedProviderId).toBe("opencode");

    await agentStore.connectAcp();
    expect(await agentStore.activateAcpProvider("mock-agent")).toBeNull();
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(agentStore.selectedProviderId).toBe("mock-agent");
  });
});

describe("ACP 停止清理", () => {
  it("stop 事件清理 ACP 状态与待决权限", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({
      sessionId: "session-1",
      configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "mock/fast", options: [{ value: "mock/fast" }] }],
    });
    h.prompt.mockResolvedValue({});
    const agentStore = useAgentStore();
    await agentStore.dispatchToAcp("下一回合");

    emit({
      kind: "permission-request",
      payload: {
        requestId: 9,
        auto: false,
        chosen: null,
        toolCallId: "tc-2",
        kind: "write",
        options: [{ optionId: "allow", name: "允许", kind: "allow_once" }],
      },
    });
    emit({ kind: "stopped", payload: {} });

    expect(agentStore.acpBusy).toBe(false);
    expect(agentStore.pendingPermission).toBeNull();
    expect(agentStore.acpConfigOptions).toEqual([]);
    agentStore.toggleRouteToAcp();
    expect(agentStore.routeToAcp).toBe(true);
  });
});

describe("并行编排（dispatchRun）", () => {
  it("无 ACP 后端时走演示降级：两个 mock 子任务顺序推进至 done", async () => {
    h.isAvailable.mockImplementation(() => false);
    const agentStore = useAgentStore();

    void agentStore.dispatchRun("梳理本周改动");

    await vi.waitFor(() => expect(agentStore.runs[0]?.status).toBe("done"), { timeout: 3000 });
    expect(agentStore.runs[0]?.subtasks).toHaveLength(2);
    expect(agentStore.runs[0]?.subtasks.every((sub) => sub.status === "done")).toBe(true);
    expect(agentStore.runs[0]?.finishedAt).toBeTypeOf("number");
  });

  it("planner 回合解析 JSON 计划后，子任务按 maxParallel 并行派发并逐个完成", async () => {
    let handleSeq = 0;
    let sessionSeq = 0;
    h.startAgent.mockImplementation(() => Promise.resolve(++handleSeq));
    h.openSession.mockImplementation(() => Promise.resolve({ sessionId: `session-${++sessionSeq}`, configOptions: [] }));
    h.prompt.mockImplementation(() => new Promise<unknown>(() => undefined));
    const agentStore = useAgentStore();
    const chat = useChatStore();

    void agentStore.dispatchRun("分析客流数据");

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
      expect(agentStore.runs[0]?.status).toBe("running");
      expect(agentStore.runs[0]?.subtasks).toHaveLength(2);
    });
    expect(h.prompt).toHaveBeenCalledTimes(3);

    // 子任务 1 流式输出并完成
    emit({
      kind: "session-update",
      payload: { session_id: "session-2", update: { sessionUpdate: "agent_message_chunk", content: { text: "已抓取 3 条" } } },
    });
    chat.flushPendingContent();
    emit({ kind: "prompt-done", payload: { handle: 2, response: {} } });
    expect(agentStore.runs[0]?.subtasks[0]?.status).toBe("done");
    expect(agentStore.runs[0]?.status).toBe("running"); // 子任务 2 仍在跑

    // 子任务 2 完成 → run done
    emit({
      kind: "session-update",
      payload: { session_id: "session-3", update: { sessionUpdate: "agent_message_chunk", content: { text: "聚类完成" } } },
    });
    chat.flushPendingContent();
    emit({ kind: "prompt-done", payload: { handle: 3, response: {} } });
    expect(agentStore.runs[0]?.subtasks.every((sub) => sub.status === "done")).toBe(true);
    expect(agentStore.runs[0]?.status).toBe("done");
  });

  it("planner 未返回有效 JSON 时 run 置 failed，不派发任何子任务", async () => {
    let handleSeq = 0;
    h.startAgent.mockImplementation(() => Promise.resolve(++handleSeq));
    h.openSession.mockImplementation(() => Promise.resolve({ sessionId: "session-1", configOptions: [] }));
    h.prompt.mockImplementation(() => new Promise<unknown>(() => undefined));
    const agentStore = useAgentStore();
    const chat = useChatStore();

    void agentStore.dispatchRun("生成日报");
    await vi.waitFor(() => expect(h.prompt).toHaveBeenCalledTimes(1));

    emit({
      kind: "session-update",
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { text: "抱歉，我无法完成" } } },
    });
    chat.flushPendingContent();
    emit({ kind: "prompt-done", payload: { handle: 1, response: {} } });

    await vi.waitFor(() => expect(agentStore.runs[0]?.status).toBe("failed"));
    expect(agentStore.runs[0]?.subtasks).toHaveLength(0);
    expect(h.startAgent).toHaveBeenCalledTimes(1); // 仅 planner
  });
});

describe("replan（执行中调整计划）", () => {
  /** 建立一次真实链路 run：planner 分解为 2 个子任务并全部完成。 */
  async function setupDoneRun(agentStore: ReturnType<typeof useAgentStore>): Promise<string> {
    let handleSeq = 0;
    let sessionSeq = 0;
    h.startAgent.mockImplementation(() => Promise.resolve(++handleSeq));
    h.openSession.mockImplementation(() => Promise.resolve({ sessionId: `session-${++sessionSeq}`, configOptions: [] }));
    h.prompt.mockImplementation(() => new Promise<unknown>(() => undefined));

    void agentStore.dispatchRun("分析客流数据");
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
    await vi.waitFor(() => expect(agentStore.runs[0]?.subtasks).toHaveLength(2));
    // 等待两个子任务各自完成 startAgent/openSession（session 已注册，handle 2/3）
    await vi.waitFor(() => expect(h.startAgent).toHaveBeenCalledTimes(3));
    emit({ kind: "prompt-done", payload: { handle: 2, response: {} } });
    emit({ kind: "prompt-done", payload: { handle: 3, response: {} } });
    await vi.waitFor(() => expect(agentStore.runs[0]?.status).toBe("done"));
    return agentStore.runs[0]?.id ?? "";
  }

  it("cancelSubtask 移除 pending 子任务，run 继续推进", async () => {
    h.isAvailable.mockImplementation(() => false);
    const agentStore = useAgentStore();
    void agentStore.dispatchRun("梳理改动");
    await vi.waitFor(() => expect(agentStore.runs[0]?.subtasks).toHaveLength(2));

    const runId = agentStore.runs[0]?.id ?? "";
    const subId = agentStore.runs[0]?.subtasks[0]?.id ?? "";
    await agentStore.cancelSubtask(runId, subId);

    expect(agentStore.runs[0]?.subtasks).toHaveLength(1);
    await vi.waitFor(() => expect(agentStore.runs[0]?.status).toBe("done"), { timeout: 3000 });
  });

  it("cancelSubtask 取消 running 子任务：停进程并出队，剩余子任务不受影响", async () => {
    const agentStore = useAgentStore();
    const runId = await setupDoneRun(agentStore); // 结束后追加逻辑
    // 追加一个 pending 子任务再取消它（队列出队路径）
    agentStore.addSubtask(runId, "builder", "补做清理");
    await vi.waitFor(() => expect(agentStore.runs[0]?.subtasks).toHaveLength(3));
    const added = agentStore.runs[0]?.subtasks[2];
    await agentStore.cancelSubtask(runId, added?.id ?? "");
    expect(agentStore.runs[0]?.subtasks).toHaveLength(2);
    expect(agentStore.runs[0]?.status).toBe("done");
  });

  it("addSubtask 追加子任务并派发：handle/session 递增、prompt 再次调用", async () => {
    const agentStore = useAgentStore();
    const runId = await setupDoneRun(agentStore);
    const promptsBefore = h.prompt.mock.calls.length;

    agentStore.addSubtask(runId, "builder", "补做清理");

    await vi.waitFor(() => expect(agentStore.runs[0]?.subtasks).toHaveLength(3));
    await vi.waitFor(() => expect(h.prompt.mock.calls.length).toBeGreaterThan(promptsBefore));
    expect(agentStore.runs[0]?.status).toBe("running");

    // 新子任务完成 → run 恢复 done
    await vi.waitFor(() => expect(h.startAgent).toHaveBeenCalledTimes(4)); // 新 session 已注册
    emit({ kind: "prompt-done", payload: { handle: 4, response: {} } });
    await vi.waitFor(() => expect(agentStore.runs[0]?.status).toBe("done"));
  });

  it("retrySubtask 重置失败子任务重新派发，run 恢复 running", async () => {
    const agentStore = useAgentStore();
    const runId = await setupDoneRun(agentStore);
    const promptsBefore = h.prompt.mock.calls.length;

    // 人为置失败，模拟某子任务执行失败
    const target = agentStore.runs[0]?.subtasks[0];
    if (target) target.status = "failed";
    agentStore.retrySubtask(runId, target?.id ?? "");

    expect(agentStore.runs[0]?.status).toBe("running");
    // retry 立即重跑：子任务应很快进入 running 并再次调用 prompt
    await vi.waitFor(() => expect(h.prompt.mock.calls.length).toBeGreaterThan(promptsBefore));
    await vi.waitFor(() => expect(agentStore.runs[0]?.subtasks[0]?.status).toBe("running"));
  });
});
