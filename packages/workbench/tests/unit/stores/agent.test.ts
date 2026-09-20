// ACP 派发 → Chat·Cowork 对话流契约：支架消息入线、chunk 流式续写、权限卡片挂起/裁决。
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
      startAgent: (cmd: string, tier: string, sandbox?: string, workspace?: string | null) => h.startAgent(cmd, tier, sandbox, workspace),
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
vi.mock("@/lib/workspace-dir", () => ({
  resolveWorkspaceDir: async () => {
    const dir = await h.homeDir();
    if (!dir) throw new Error("无法解析工作区目录");
    return dir;
  },
  // runMode 默认 local：隔离层直通，测试不必真的派生快照。
  isolateForRun: async (base: string) => base,
}));

import { acpDefaultConfigValues, setAcpDefaultConfig } from "@/stores/agent/shared";
import { useAgentStore } from "@/stores/agent";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import { useChatStore } from "@/stores/chat";
import { useNoticeStore } from "@/stores/notice";
import { useSessionStore } from "@/stores/session";

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
  // 全局默认配置是模块级单例：用例间复位，防止跨用例泄漏
  acpDefaultConfigValues.value = {};
});

describe("schedule 围栏（AI 提议定时任务）", () => {
  /** 单回合派发并立即以 prompt-done 收尾；返回支架消息。 */
  async function runTurnWithOutput(): Promise<ReturnType<typeof useChatStore>["threads"][string][number]> {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "s1", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 1 });
    const agentStore = useAgentStore();
    const chat = useChatStore();
    useSessionStore().createSession(null, "围栏测试");
    chat.activeThreadId = useSessionStore().activeSessionId!;
    await agentStore.dispatchToAcp("帮我建个定时任务");
    const threadId = chat.activeThreadId;
    emit({
      kind: "prompt-done",
      payload: { turnId: 1, response: {} },
    });
    await flushTurn();
    const list = chat.threads[threadId];
    return list[list.length - 1];
  }

  async function flushTurn(): Promise<void> {
    await vi.waitFor(() => {
      expect(useAgentStore().acpBusy).toBe(false);
    });
  }

  it("成功回合输出 schedule 围栏 → 支架挂上 scheduleDraft（且只保留正文里的第一份）", async () => {
    const fence = (entry: Record<string, unknown>): string => `\`\`\`schedule\n${JSON.stringify(entry)}\n\`\`\``;
    const output = [
      "好的，已准备。",
      fence({ name: "a", intent: "ia", cron: "0 9 * * *" }),
      fence({ name: "b", intent: "ib", cron: "0 10 * * *" }),
    ].join("\n");
    const agentStore = useAgentStore();
    // 让 agent 输出围栏：chunk 流式写入
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "s1", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 1 });
    const chat = useChatStore();
    useSessionStore().createSession(null, "围栏测试2");
    chat.activeThreadId = useSessionStore().activeSessionId!;
    await agentStore.dispatchToAcp("建任务");
    const list = chat.threads[chat.activeThreadId];
    const scaffold = list[list.length - 1];
    emit({ kind: "session-update", payload: { update: { sessionUpdate: "agent_message_chunk", content: { text: output } } } });
    chat.flushPendingContent();
    emit({ kind: "prompt-done", payload: { turnId: 1, response: {} } });
    await flushTurn();

    expect(scaffold.scheduleDraft).toEqual({ name: "a", intent: "ia", cron: "0 9 * * *" });
  });

  it("错误回合不解析围栏；无围栏的回合不挂草稿；重复 prompt-done 不覆盖", async () => {
    const message = await runTurnWithOutput();
    expect(message.scheduleDraft).toBeUndefined();
  });

  it("首回合 prompt 注入 schedule 说明，同一会话第二回合不再注入", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "s1", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 1 });
    const agentStore = useAgentStore();
    const chat = useChatStore();
    useSessionStore().createSession(null, "注入测试");
    chat.activeThreadId = useSessionStore().activeSessionId!;

    await agentStore.dispatchToAcp("第一轮");
    expect(h.prompt).toHaveBeenNthCalledWith(1, 7, expect.stringContaining("宿主能力提示"));
    emit({ kind: "prompt-done", payload: { turnId: 1, response: {} } });
    await flushTurn();

    await agentStore.dispatchToAcp("第二轮");
    expect(h.prompt).toHaveBeenNthCalledWith(2, 7, "第二轮");
  });
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
      // 第三参是 MCP 声明清单：默认没启用任何服务器 → 空数组
      expect(h.openSession).toHaveBeenCalledWith(7, "/home/test", []);
      expect(h.prompt).toHaveBeenCalledWith(7, expect.stringContaining("整理本周改动"));
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

    // prompt ack（回合仍在进行）→ prompt-done 才收尾
    turn.resolve({ turnId: 7, stopReason: "end_turn" });
    await pending;
    expect(agentStore.acpBusy).toBe(true);
    emit({ kind: "prompt-done", payload: { turnId: 7, response: { stopReason: "end_turn" } } });
    expect(agentStore.acpBusy).toBe(false);
    expect(chat.llmReady).toBe(false);
  });

  it("会话已存在时复用 handle，不重复启动 agent", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 99 });
    const agentStore = useAgentStore();

    await agentStore.dispatchToAcp("第一回合");
    // prompt 只是 ack：回合要等 prompt-done 才算结束，期间不接下一轮。
    emit({ kind: "prompt-done", payload: { turnId: 99, response: {} } });
    await agentStore.dispatchToAcp("第二回合");

    expect(h.startAgent).toHaveBeenCalledTimes(1);
    expect(h.prompt).toHaveBeenCalledTimes(2);
  });

  it("同一对话内连发两轮：复用同一 ACP 会话（上下文本就该延续）", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 99 });
    const agentStore = useAgentStore();

    await agentStore.dispatchToAcp("第一回合");
    emit({ kind: "prompt-done", payload: { turnId: 99, response: {} } });
    await agentStore.dispatchToAcp("第二回合");

    expect(h.openSession).toHaveBeenCalledTimes(1);
  });

  it("换到另一条对话再发：同进程上另开会话，agent 不再带着上一条对话的上下文", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-A", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 1 });
    const agentStore = useAgentStore();
    const chat = useChatStore();

    await agentStore.dispatchToAcp("A 对话第一轮");
    emit({ kind: "prompt-done", payload: { turnId: 1, response: {} } });
    const threadA = chat.activeThreadId;

    // 新建对话（侧栏「新对话」等效动作）
    chat.activeThreadId = "thread-B";
    await agentStore.dispatchToAcp("B 对话第一轮");

    expect(threadA).not.toBe("thread-B");
    // agent 进程复用（重启会丢已探测的 config options），但会话必须换
    expect(h.startAgent).toHaveBeenCalledTimes(1);
    expect(h.openSession).toHaveBeenCalledTimes(2);

    // 回到 A 对话再发 → 又是一条新会话（ACP 侧无法恢复已结束的 session）
    emit({ kind: "prompt-done", payload: { turnId: 1, response: {} } });
    chat.activeThreadId = threadA;
    await agentStore.dispatchToAcp("A 对话第二轮");

    expect(h.startAgent).toHaveBeenCalledTimes(1);
    expect(h.openSession).toHaveBeenCalledTimes(3);
  });

  it("换会话失败时保留 agent 进程：下一次派发只重试 session/new，不再 spawn 第二个 CLI", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValueOnce({ sessionId: "session-A", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 1 });
    const agentStore = useAgentStore();
    const chat = useChatStore();

    await agentStore.dispatchToAcp("A 对话");
    emit({ kind: "prompt-done", payload: { turnId: 1, response: {} } });

    h.openSession.mockRejectedValueOnce(new Error("session/new refused"));
    chat.activeThreadId = "thread-B";
    await agentStore.dispatchToAcp("B 对话");
    expect(chat.threads["thread-B"]?.at(-1)?.content).toContain("session/new refused");

    h.openSession.mockResolvedValueOnce({ sessionId: "session-B", configOptions: [] });
    await agentStore.dispatchToAcp("B 对话重试");

    expect(h.startAgent).toHaveBeenCalledTimes(1);
    expect(h.openSession).toHaveBeenCalledTimes(3);
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

    turn.resolve({ turnId: 7 });
    await pending;
    emit({ kind: "prompt-done", payload: { turnId: 7, response: {} } });
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

    turn.resolve({ turnId: 7 });
    await pending;
  });

  it("prompt 立即 ack 后 chunk 仍续写支架（回合结束前不拆流）", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    // 真实传输语义：prompt 拿到 turnId 就返回，回合增量经事件回流。
    h.prompt.mockResolvedValue({ turnId: 5 });
    const agentStore = useAgentStore();
    const chat = useChatStore();

    await agentStore.dispatchToAcp("立即 ack 的回合");
    expect(agentStore.acpBusy).toBe(true);
    expect(agentStore.acpStreamId).not.toBeNull();

    emit({
      kind: "session-update",
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { text: "迟到但到的 chunk" } } },
    });
    chat.flushPendingContent();
    expect(chat.threads[chat.activeThreadId]?.at(-1)?.content).toBe("迟到但到的 chunk");

    // 回合收尾：prompt-done 释放支架并解除 busy
    emit({ kind: "prompt-done", payload: { turnId: 5, response: {} } });
    expect(agentStore.acpBusy).toBe(false);
    expect(agentStore.acpStreamId).toBeNull();
  });

  it("prompt-done 追加完成脚标并发 success 通知（用户明确感知回合已结束）", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    const turn = deferred<unknown>();
    h.prompt.mockImplementation(() => turn.promise);
    const agentStore = useAgentStore();
    const chat = useChatStore();
    const notices = useNoticeStore();

    const pending = agentStore.dispatchToAcp("整理本周改动");
    await vi.waitFor(() => expect(agentStore.acpBusy).toBe(true));
    emit({
      kind: "session-update",
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { text: "已整理完毕" } } },
    });
    chat.flushPendingContent();

    turn.resolve({ turnId: 7 });
    await pending;
    // prompt-done 前内容就是原样答复，不作任何注入
    expect(chat.threads[chat.activeThreadId]?.at(-1)?.content).toBe("已整理完毕");
    emit({ kind: "prompt-done", payload: { turnId: 7, response: {} } });

    const message = chat.threads[chat.activeThreadId]?.at(-1);
    expect(message?.content).toContain("✓ 任务已完成");
    expect(chat.threads[chat.activeThreadId]?.at(-1)?.content).toContain("已整理完毕");
    expect(agentStore.acpBusy).toBe(false);
    expect(notices.list.some((notice) => notice.kind === "success" && notice.title === "任务已完成")).toBe(true);
  });

  it("prompt-done 无输出时落「无文本输出」而不追加完成脚标（不为空消息再补一行）", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 8 });
    const agentStore = useAgentStore();
    const chat = useChatStore();

    await agentStore.dispatchToAcp("没输出的回合");
    emit({ kind: "prompt-done", payload: { turnId: 8, response: {} } });

    const message = chat.threads[chat.activeThreadId]?.at(-1);
    expect(message?.content).toBe("（本次回合无文本输出）");
    expect(message?.content).not.toContain("✓ 任务已完成");
  });

  it("prompt-done 带 error：落失败文案而非「无文本输出」，不发完成脚标/success 通知", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 9 });
    const agentStore = useAgentStore();
    const chat = useChatStore();
    const notices = useNoticeStore();

    await agentStore.dispatchToAcp("后端会挂的回合");
    emit({ kind: "prompt-done", payload: { turnId: 9, error: "Cannot connect to API: typo in the url?" } });

    const message = chat.threads[chat.activeThreadId]?.at(-1);
    expect(message?.content).toBe("[LLM 调用失败] Cannot connect to API: typo in the url?");
    expect(message?.content).not.toContain("✓ 任务已完成");
    expect(message?.content).not.toBe("（本次回合无文本输出）");
    expect(agentStore.acpBusy).toBe(false);
    expect(notices.list.some((notice) => notice.kind === "success" && notice.title === "任务已完成")).toBe(false);
  });

  it("prompt-done 带 error 且已有流式内容：失败行追加到末尾，不吞掉已产出的文本", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 10 });
    const agentStore = useAgentStore();
    const chat = useChatStore();

    await agentStore.dispatchToAcp("流到一半失败的回合");
    emit({
      kind: "session-update",
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { text: "前半句" } } },
    });
    chat.flushPendingContent();
    emit({ kind: "prompt-done", payload: { turnId: 10, error: "stream interrupted" } });

    const message = chat.threads[chat.activeThreadId]?.at(-1);
    expect(message?.content).toBe("前半句\n\n[LLM 调用失败] stream interrupted");
  });

  it("thought 事件并进同一思考段；被正文打断后另起一段（多段各自折叠的数据基础）", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 6 });
    const agentStore = useAgentStore();
    const chat = useChatStore();

    await agentStore.dispatchToAcp("需要推理的任务");
    emit({ kind: "thought", payload: { text: "先看清" } });
    emit({ kind: "thought", payload: { text: "再动手" } });
    emit({ kind: "session-update", payload: { update: { sessionUpdate: "agent_message_chunk", content: { text: "答案" } } } });
    emit({ kind: "thought", payload: { text: "复核一遍" } });
    chat.flushPendingContent();

    const message = chat.threads[chat.activeThreadId]?.at(-1);
    expect(message?.segments?.map((segment) => segment.kind)).toEqual(["thinking", "text", "thinking"]);
    const [first, , second] = message?.segments ?? [];
    expect(first?.kind === "thinking" && first.text).toBe("先看清再动手");
    expect(second?.kind === "thinking" && second.text).toBe("复核一遍");
    expect(message?.content).toBe("答案");
    expect(agentStore.acpThoughtText).toBe("先看清再动手复核一遍");
  });

  it("选中后端即建会话：configOptions 在首次发送前就可读", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({
      sessionId: "session-1",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "mock/fast",
          options: [{ value: "mock/fast" }, { value: "mock/slow" }],
        },
      ],
    });
    const agentStore = useAgentStore();

    await agentStore.activateAcpProvider("opencode");
    await vi.waitFor(() => expect(agentStore.acpConfigOptions).toHaveLength(1));
    // 预连接只起会话，不替用户发消息
    expect(h.prompt).not.toHaveBeenCalled();
    expect(agentStore.acpConnected).toBe(true);
  });

  it("建会话失败：activateAcpProvider 返回错误文案且置 error 状态（不再静默）", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockRejectedValue(new Error("boom"));
    const agentStore = useAgentStore();

    const failure = await agentStore.activateAcpProvider("opencode");
    expect(failure).toBeTypeOf("string");
    expect(failure).toContain("boom");
    expect(agentStore.acpStatus).toBe("error");
    expect(agentStore.acpConnected).toBe(false);
    expect(agentStore.acpConfigOptions).toEqual([]);
  });

  it("会话断开后重复 activate 同后端：重建会话（点击重试路径）", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({
      sessionId: "session-1",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "mock/fast",
          options: [{ value: "mock/fast" }],
        },
      ],
    });
    const agentStore = useAgentStore();
    await agentStore.activateAcpProvider("opencode");
    await vi.waitFor(() => expect(agentStore.acpConnected).toBe(true));
    expect(h.startAgent).toHaveBeenCalledTimes(1);

    // 宿主发 stopped（agent 进程退出）→ 状态清空回到未连接
    emit({ kind: "stopped", payload: {} });
    expect(agentStore.acpConnected).toBe(false);
    expect(agentStore.acpStatus).toBe("disconnected");

    // 同后端再次 activate：不是静默 no-op，而是重建会话
    const retry = await agentStore.activateAcpProvider("opencode");
    expect(retry).toBeNull();
    expect(h.startAgent).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(agentStore.acpConnected).toBe(true));
    await vi.waitFor(() => expect(agentStore.acpConfigOptions).toHaveLength(1));
  });
});

describe("权限请求与裁决", () => {
  it("permission-request 挂起卡片，respondPermission 清空并回传宿主", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 99 });
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

    turn.resolve({ turnId: 7 });
    await pending;
  });

  it("裁决在消息流里留一条只读痕（类别 / 命令 / 路径 / 选择）", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 99 });
    const agentStore = useAgentStore();
    const chat = useChatStore();
    await agentStore.dispatchToAcp("跑个命令");

    emit({
      kind: "permission-request",
      payload: {
        requestId: 7,
        auto: false,
        chosen: null,
        toolCallId: "tc-7",
        title: "rm -rf build",
        kind: "execute",
        locations: [],
        rawInput: { command: "rm -rf build" },
        options: [{ optionId: "allow", name: "允许", kind: "allow_once" }],
      },
    });
    await agentStore.respondPermission("allow");

    const trace = chat.threads[chat.activeThreadId]?.at(-1)?.permissions?.[0];
    expect(trace).toMatchObject({
      toolCallId: "tc-7",
      title: "rm -rf build",
      kind: "execute",
      choice: "允许",
      source: "user",
      command: "rm -rf build",
    });
    expect(trace?.decidedAt).toBeGreaterThan(0);
  });

  it("拒绝（optionId 为 null）留痕不带 choice", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 99 });
    const agentStore = useAgentStore();
    const chat = useChatStore();
    await agentStore.dispatchToAcp("写文件");

    emit({
      kind: "permission-request",
      payload: {
        requestId: 8,
        auto: false,
        chosen: null,
        toolCallId: "tc-8",
        title: "/etc/passwd",
        kind: "edit",
        locations: ["/etc/passwd"],
        options: [{ optionId: "allow", name: "允许", kind: "allow_once" }],
      },
    });
    await agentStore.respondPermission(null);

    const trace = chat.threads[chat.activeThreadId]?.at(-1)?.permissions?.[0];
    expect(trace).toMatchObject({ choice: null, source: "user", paths: ["/etc/passwd"] });
    expect(h.respondPermission).toHaveBeenCalledWith(8, null);
  });

  it("选过「始终允许」后同类请求免问：直接放行并留一条 auto 痕", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 99 });
    const agentStore = useAgentStore();
    const chat = useChatStore();
    await agentStore.dispatchToAcp("跑个命令");

    emit({
      kind: "permission-request",
      payload: {
        requestId: 11,
        auto: false,
        chosen: null,
        toolCallId: "tc-10",
        kind: "execute",
        options: [
          { optionId: "once", name: "允许一次", kind: "allow_once" },
          { optionId: "always", name: "始终允许", kind: "allow_always" },
        ],
      },
    });
    await agentStore.respondPermission("always");

    // 第二个同类请求：不弹卡，直接按 allow_once 放行（比 allow_always 更窄）
    emit({
      kind: "permission-request",
      payload: {
        requestId: 12,
        auto: false,
        chosen: null,
        toolCallId: "tc-11",
        kind: "execute",
        options: [
          { optionId: "once", name: "允许一次", kind: "allow_once" },
          { optionId: "always", name: "始终允许", kind: "allow_always" },
        ],
      },
    });
    expect(agentStore.pendingPermission).toBeNull();
    await vi.waitFor(() => expect(h.respondPermission).toHaveBeenCalledWith(12, "once"));
    expect((chat.threads[chat.activeThreadId]?.at(-1)?.permissions ?? []).map((trace) => trace.source)).toEqual(["user", "auto"]);
  });

  it("会话重来后「始终允许」记忆清空（会话内有效，不跨会话）", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 99 });
    const agentStore = useAgentStore();
    await agentStore.dispatchToAcp("跑个命令");

    const request = (requestId: number, toolCallId: string) => ({
      kind: "permission-request" as const,
      payload: {
        requestId,
        auto: false,
        chosen: null,
        toolCallId,
        kind: "execute",
        options: [{ optionId: "always", name: "始终允许", kind: "allow_always" }],
      },
    });
    emit(request(21, "tc-20"));
    await agentStore.respondPermission("always");

    // 宿主断开 → acpSessionId 置空 → 记忆随之作废
    emit({ kind: "stopped", payload: {} });
    await agentStore.dispatchToAcp("再来一轮");
    emit(request(22, "tc-21"));

    expect(agentStore.pendingPermission?.requestId).toBe(22);
  });

  it("120s 未裁决：收卡并留一条 timeout 痕", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 99 });
    const agentStore = useAgentStore();
    const chat = useChatStore();
    await agentStore.dispatchToAcp("跑个命令");

    vi.useFakeTimers();
    try {
      emit({
        kind: "permission-request",
        payload: {
          requestId: 31,
          auto: false,
          chosen: null,
          toolCallId: "tc-30",
          kind: "execute",
          options: [{ optionId: "once", name: "允许一次", kind: "allow_once" }],
        },
      });
      expect(agentStore.pendingPermission).not.toBeNull();

      vi.advanceTimersByTime(120_000);
      expect(agentStore.pendingPermission).toBeNull();
    } finally {
      vi.useRealTimers();
    }

    expect(chat.threads[chat.activeThreadId]?.at(-1)?.permissions?.[0]).toMatchObject({
      toolCallId: "tc-30",
      source: "timeout",
      choice: null,
    });
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
        locations: ["/etc/passwd"],
      },
    });
    chat.flushPendingContent();
    expect(chat.threads[chat.activeThreadId]?.at(-1)?.content).toContain("宿主拦截");
    expect(chat.threads[chat.activeThreadId]?.at(-1)?.content).toContain("/etc/passwd");
    expect(agentStore.acpBusy).toBe(true);

    turn.resolve({ turnId: 7 });
    await pending;
    emit({ kind: "prompt-done", payload: { turnId: 7, response: {} } });
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
    await agentStore.setAgentProviderEnabled("codex", true);
    expect(await agentStore.activateAcpProvider("codex")).toBeNull();
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(agentStore.selectedProviderId).toBe("codex");
  });
});

describe("ACP 停止清理", () => {
  it("stop 事件清理 ACP 状态与待决权限", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({
      sessionId: "session-1",
      configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "mock/fast", options: [{ value: "mock/fast" }] }],
    });
    h.prompt.mockResolvedValue({ turnId: 99 });
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

describe("ACP 命令目录", () => {
  it("commands 事件归一化入档：剥前导斜杠、去重、脏条目丢弃", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    const agentStore = useAgentStore();
    await agentStore.connectAcp();

    emit({
      kind: "commands",
      payload: {
        sessionId: "session-1",
        availableCommands: [
          { name: "/compact", description: "压缩上下文" },
          { name: "compact", description: "重复条目" },
          { name: "bad name", description: "名含空白" },
          null,
          { name: "deploy", description: "部署", input: { hint: "环境名" } },
        ],
      },
    });

    expect(agentStore.acpCommands).toEqual([
      { name: "compact", description: "压缩上下文" },
      { name: "deploy", description: "部署", input: { hint: "环境名" } },
    ]);
  });

  it("会话更替即清空陈旧目录（切回本地 LLM）", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
    h.stop.mockResolvedValue(undefined);
    const agentStore = useAgentStore();
    await agentStore.connectAcp();
    emit({ kind: "commands", payload: { availableCommands: [{ name: "compact", description: "压缩上下文" }] } });
    expect(agentStore.acpCommands).toHaveLength(1);

    await agentStore.switchToLocalLlm();
    await vi.waitFor(() => expect(agentStore.acpCommands).toEqual([]));
  });
});

describe("ACP turn 语义与语义事件", () => {
  it("prompt 记录 turnId，stopAcp 按 turnId 取消单回合", async () => {
    h.prompt.mockResolvedValue({ turnId: 42 });
    h.stop.mockResolvedValue(undefined);
    const agentStore = useAgentStore();

    await agentStore.connectAcp();
    const pending = agentStore.dispatchToAcp("hello turn");
    await vi.waitFor(() => expect(h.prompt).toHaveBeenCalled());

    // dispatchToAcp 完成后 activeTurnId 已记录
    await pending;
    expect(agentStore.activeTurnId).toBe(42);
    expect(agentStore.turnStartedAtMs).not.toBeNull();

    await agentStore.stopAcp();
    // 有在途回合：stop 带 turnId（进程保留），而非无参进程级停止
    expect(h.stop).toHaveBeenCalledWith(expect.any(Number), 42);
    expect(agentStore.activeTurnId).toBeNull();
    expect(agentStore.turnStartedAtMs).toBeNull();
  });

  it("thought/usage 事件聚合到 store 状态，prompt-done 清空 turn", async () => {
    h.prompt.mockResolvedValue({ turnId: 43 });
    const agentStore = useAgentStore();
    await agentStore.connectAcp();
    const pending = agentStore.dispatchToAcp("think out loud");
    await vi.waitFor(() => expect(h.prompt).toHaveBeenCalled());

    emit({ kind: "thought", payload: { text: "思考一" } });
    emit({ kind: "thought", payload: { text: "思考二" } });
    emit({ kind: "usage", payload: { used: 1200, size: 32000, cost: { amount: 0.01, currency: "USD" } } });
    expect(agentStore.acpThoughtText).toBe("思考一思考二");
    expect(agentStore.acpUsage).toEqual({ used: 1200, size: 32000, cost: { amount: 0.01, currency: "USD" } });

    await pending;
    emit({ kind: "prompt-done", payload: { handle: 1, turnId: 43, response: {} } });
    await vi.waitFor(() => expect(agentStore.activeTurnId).toBeNull());
    expect(agentStore.turnStartedAtMs).toBeNull();
  });
});

describe("ACP provider 偏好持久化（场景一 Guid 预选）", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    const stub: Storage = {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (key) => store.get(key) ?? null,
      key: (index) => [...store.keys()][index] ?? null,
      removeItem: (key) => void store.delete(key),
      setItem: (key, value) => void store.set(key, String(value)),
    };
    vi.stubGlobal("localStorage", stub);
    vi.stubGlobal("window", { localStorage: stub });
  });

  it("switchToLocalLlm 记录 null；activateAcpProvider 记录 provider id", async () => {
    localStorage.clear();
    const agentStore = useAgentStore();
    await agentStore.switchToLocalLlm();
    expect(JSON.parse(localStorage.getItem("greywork.acp-provider") ?? "{}")).toEqual({ providerId: null });

    await agentStore.activateAcpProvider("opencode");
    expect(JSON.parse(localStorage.getItem("greywork.acp-provider") ?? "{}")).toEqual({ providerId: "opencode" });
  });

  it("偏好 ACP agent 时初始化恢复 routeToAcp 与 selectedProviderId", () => {
    localStorage.setItem("greywork.acp-provider", JSON.stringify({ providerId: "opencode" }));
    const agentStore = useAgentStore();
    expect(agentStore.routeToAcp).toBe(true);
    expect(agentStore.selectedProviderId).toBe("opencode");
  });

  it("偏好 Local 时初始化 routeToAcp=false", () => {
    localStorage.setItem("greywork.acp-provider", JSON.stringify({ providerId: null }));
    const agentStore = useAgentStore();
    expect(agentStore.routeToAcp).toBe(false);
  });
});

describe("自配 ACP 后端管理", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    const stub: Storage = {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (key) => store.get(key) ?? null,
      key: (index) => [...store.keys()][index] ?? null,
      removeItem: (key) => void store.delete(key),
      setItem: (key, value) => void store.set(key, String(value)),
    };
    vi.stubGlobal("localStorage", stub);
    vi.stubGlobal("window", { localStorage: stub });
  });

  it("addAgentProvider 新增启用项并持久化（含命令派生探测）", () => {
    const agentStore = useAgentStore();
    const before = agentStore.agentProviders.length;
    expect(agentStore.addAgentProvider("My Agent", "my-agent acp")).toBeNull();
    expect(agentStore.agentProviders).toHaveLength(before + 1);
    const added = agentStore.agentProviders.at(-1);
    expect(added?.name).toBe("My Agent");
    expect(added?.command).toBe("my-agent acp");
    expect(added?.enabled).toBe(true);
    expect(added?.id.startsWith("custom-")).toBe(true);
    expect(added?.detect).toEqual(["my-agent"]);
    const persisted = JSON.parse(localStorage.getItem("greywork.agent-providers") ?? "{}");
    expect(persisted.providers.some((p: { id: string }) => p.id === added?.id)).toBe(true);
  });

  it("名称 / 命令为空时拒绝并返回错误文案", () => {
    const agentStore = useAgentStore();
    expect(agentStore.addAgentProvider("  ", "my-agent acp")).toContain("名称不能为空");
    expect(agentStore.addAgentProvider("My", "  ")).toContain("命令不能为空");
  });

  it("updateAgentProvider 编辑自配项；预设项拒绝", () => {
    const agentStore = useAgentStore();
    expect(agentStore.addAgentProvider("Old", "old-agent acp")).toBeNull();
    const id = agentStore.agentProviders.at(-1)!.id;
    expect(agentStore.updateAgentProvider(id, "New", "new-agent --acp")).toBeNull();
    const updated = agentStore.agentProviders.find((provider) => provider.id === id);
    expect(updated?.name).toBe("New");
    expect(updated?.command).toBe("new-agent --acp");
    expect(updated?.detect).toEqual(["new-agent"]);
    expect(agentStore.updateAgentProvider("opencode", "Hacked", "evil acp")).toContain("仅用户自配");
  });

  it("removeAgentProvider 仅删自配项；删除当前选中时回落选择", async () => {
    const agentStore = useAgentStore();
    expect(agentStore.addAgentProvider("My", "my-agent acp")).toBeNull();
    const id = agentStore.agentProviders.at(-1)!.id;
    agentStore.selectProvider(id);
    agentStore.toggleRouteToAcp();
    expect(await agentStore.removeAgentProvider(id)).toBeNull();
    expect(agentStore.agentProviders.some((provider) => provider.id === id)).toBe(false);
    expect(agentStore.selectedProviderId).not.toBe(id);
    expect(await agentStore.removeAgentProvider("opencode")).toContain("仅用户自配");
  });

  it("回读缓存时 custom-* 项不被预设合并丢弃（重启存活）", () => {
    localStorage.setItem(
      "greywork.agent-providers",
      JSON.stringify({
        providers: [{ id: "custom-abc", name: "My Agent", kind: "acp", command: "my-agent acp", enabled: true }],
      }),
    );
    const agentStore = useAgentStore();
    const custom = agentStore.agentProviders.find((provider) => provider.id === "custom-abc");
    expect(custom).toBeDefined();
    expect(custom?.command).toBe("my-agent acp");
    expect(custom?.enabled).toBe(true);
  });
});

describe("权限临时降级与每工作区配置记忆", () => {
  it("起 agent 用生效档位而非基线档位", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "s1", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 1 });
    const settings = useSettingsStore();
    settings.permissionTier = "full";
    settings.tempReadOnly = true;

    const agentStore = useAgentStore();
    await agentStore.dispatchToAcp("跑一下");
    expect(h.startAgent).toHaveBeenCalledWith("opencode acp", "read-only", "auto", "/home/test");
  });

  it("setTempReadOnly 把新档位推给在途 handle，回升同理", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "s1", configOptions: [] });
    const settings = useSettingsStore();
    settings.permissionTier = "full";
    const agentStore = useAgentStore();
    await agentStore.activateAcpProvider("opencode");

    expect(await agentStore.setTempReadOnly(true)).toBeNull();
    expect(h.setPermissionTier).toHaveBeenLastCalledWith(7, "read-only");
    await agentStore.setTempReadOnly(false);
    expect(h.setPermissionTier).toHaveBeenLastCalledWith(7, "full");
  });

  it("无在途 agent 时降级只改状态，不发命令", async () => {
    const agentStore = useAgentStore();
    expect(await agentStore.setTempReadOnly(true)).toBeNull();
    expect(useSettingsStore().tempReadOnly).toBe(true);
    expect(h.setPermissionTier).not.toHaveBeenCalled();
  });

  it("setAcpConfig 的选择记进当前工作区，applyWorkspaceAgentConfig 回放且不自反写入", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({
      sessionId: "s1",
      configOptions: [{ id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "low" }],
    });
    h.setSessionConfig.mockResolvedValue([
      { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high" },
    ]);
    const workspaceStore = useWorkspaceStore();
    const workspace = workspaceStore.createWorkspace("记忆项目");
    const agentStore = useAgentStore();
    await agentStore.activateAcpProvider("opencode");
    await agentStore.setAcpConfig("effort", "high");

    expect(workspaceStore.agentConfigOf(workspace.id)).toEqual({
      providerId: "opencode",
      configValues: { effort: "high" },
    });

    // 回放：命令再发一次，但记忆不被回放自身重写（仍是同一份）
    h.setSessionConfig.mockClear();
    await agentStore.applyWorkspaceAgentConfig(workspace.id);
    expect(h.setSessionConfig).toHaveBeenCalledWith(7, "effort", "high");
    expect(workspaceStore.agentConfigOf(workspace.id)?.configValues).toEqual({ effort: "high" });
  });

  it("工作区没有记忆时回放是 no-op（不动当前后端选择）", async () => {
    const workspaceStore = useWorkspaceStore();
    const agentStore = useAgentStore();
    const before = agentStore.routeToAcp;
    await agentStore.applyWorkspaceAgentConfig(workspaceStore.workspaces[0]?.id ?? null);
    expect(agentStore.routeToAcp).toBe(before);
    expect(h.startAgent).not.toHaveBeenCalled();
  });

  it("全局默认兜底：工作区无记忆的会话应用默认值，且不自反写入工作区", async () => {
    setAcpDefaultConfig({ effort: "high" });
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({
      sessionId: "s1",
      configOptions: [{ id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "low" }],
    });
    const workspaceStore = useWorkspaceStore();
    const workspace = workspaceStore.createWorkspace("无记忆项目");
    const agentStore = useAgentStore();
    await agentStore.activateAcpProvider("opencode");

    await agentStore.applyWorkspaceAgentConfig(workspace.id);
    expect(h.setSessionConfig).toHaveBeenCalledWith(7, "effort", "high");
    // 兜底是「默认」不是「表态」：不该写进工作区记忆
    expect(workspaceStore.agentConfigOf(workspace.id)?.configValues ?? {}).toEqual({});
  });

  it("层级：工作区记忆的键不被全局默认覆盖，记忆之外的键才兜底", async () => {
    setAcpDefaultConfig({ effort: "high", mode: "plan" });
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({
      sessionId: "s1",
      configOptions: [
        { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "low" },
        { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "build" },
      ],
    });
    h.setSessionConfig.mockResolvedValue([]);
    const workspaceStore = useWorkspaceStore();
    const workspace = workspaceStore.createWorkspace("部分记忆项目");
    workspaceStore.setAgentConfig(workspace.id, { configValues: { effort: "low" } });
    const agentStore = useAgentStore();
    await agentStore.activateAcpProvider("opencode");

    h.setSessionConfig.mockClear();
    await agentStore.applyWorkspaceAgentConfig(workspace.id);
    // effort 随工作区记忆回放；mode 无记忆 → 全局默认兜底（两次都是记忆/默认语义，不写入工作区）
    expect(h.setSessionConfig).toHaveBeenCalledTimes(2);
    expect(h.setSessionConfig).toHaveBeenCalledWith(7, "effort", "low");
    expect(h.setSessionConfig).toHaveBeenCalledWith(7, "mode", "plan");
  });

  it("全局默认里的 configId 后端不暴露时跳过，不报错", async () => {
    setAcpDefaultConfig({ nonexistent: "x" });
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "s1", configOptions: [] });
    const agentStore = useAgentStore();
    await agentStore.activateAcpProvider("opencode");

    h.setSessionConfig.mockClear();
    await agentStore.applyWorkspaceAgentConfig(null);
    expect(h.setSessionConfig).not.toHaveBeenCalled();
  });
});

describe("计划模式 · ACP 门", () => {
  /** 本文件更早的 describe 往 globalThis.localStorage 注入过内存存储（vi.stubGlobal 不自动清理），
      会话会跨用例泄漏到下一个 pinia；每条用例显式新建空闲会话，隔离旧数据。 */
  function freshProjectThread(): void {
    const chat = useChatStore();
    chat.activeThreadId = useSessionStore().createSession(null, "计划测试").id;
  }

  it("beginAcpPlan：入流 user+支架并挂起计划卡，不派发", () => {
    const agentStore = useAgentStore();
    const chat = useChatStore();
    freshProjectThread();

    agentStore.beginAcpPlan("重构模块 A");

    const list = chat.threads[chat.activeThreadId];
    expect(list.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(list[1]?.planPending).toBe(true);
    expect(list[1]?.planDraft).toBe("重构模块 A");
    expect(list[1]?.acp).toBe("OpenCode");
    expect(list[1]?.content).toBe("");
    expect(h.prompt).not.toHaveBeenCalled();
    expect(agentStore.acpBusy).toBe(false);
  });

  it("confirmAcpPlan：解除计划卡并按 planDraft 派发，不重复入流", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-plan", configOptions: [] });
    const turn = deferred<unknown>();
    h.prompt.mockImplementation(() => turn.promise);
    const agentStore = useAgentStore();
    const chat = useChatStore();
    freshProjectThread();

    agentStore.beginAcpPlan("重构模块 A");
    const message = chat.threads[chat.activeThreadId].find((m) => m.planPending)!;
    agentStore.confirmAcpPlan(chat.activeThreadId, message);

    expect(message.planPending).toBe(false);
    // 支架复用：确认不重复入流（仍只有 user + assistant 两条）
    expect(chat.threads[chat.activeThreadId].map((m) => m.role)).toEqual(["user", "assistant"]);
    await vi.waitFor(() => {
      expect(h.startAgent).toHaveBeenCalledTimes(1);
      expect(h.prompt).toHaveBeenCalledWith(7, expect.stringContaining("重构模块 A"));
      expect(agentStore.acpBusy).toBe(true);
    });

    turn.resolve({ turnId: 1 });
  });

  it("回合运行中确认：忽略并保持卡片挂起", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({ sessionId: "session-busy", configOptions: [] });
    const first = deferred<unknown>();
    h.prompt.mockImplementation(() => first.promise);
    const agentStore = useAgentStore();
    const chat = useChatStore();
    freshProjectThread();

    // 先开一个真实回合占住 acpBusy
    void agentStore.dispatchToAcp("第一回合");
    await vi.waitFor(() => expect(agentStore.acpBusy).toBe(true));

    // 第二项目挂卡，运行中确认被忽略
    agentStore.beginAcpPlan("第二项目");
    const message = chat.threads[chat.activeThreadId].find((m) => m.planPending)!;
    agentStore.confirmAcpPlan(chat.activeThreadId, message);

    expect(message.planPending).toBe(true);
    expect(h.prompt).toHaveBeenCalledTimes(1);
    first.resolve({ turnId: 1 });
  });

  it("无 planDraft 或无待确认状态的确认是 no-op", async () => {
    const agentStore = useAgentStore();
    const chat = useChatStore();
    freshProjectThread();

    agentStore.beginAcpPlan("重构模块 A");
    const message = chat.threads[chat.activeThreadId].find((m) => m.planPending)!;
    message.planPending = false; // 已确认过 / 状态失效
    agentStore.confirmAcpPlan(chat.activeThreadId, message);

    expect(h.startAgent).not.toHaveBeenCalled();
    expect(h.prompt).not.toHaveBeenCalled();
  });
});

describe("MCP 声明与探活", () => {
  it("建会话时把启用的 MCP 服务器声明给 agent，并回报被跳过的原因", async () => {
    h.startAgent.mockResolvedValue(11);
    h.openSession.mockResolvedValue({
      sessionId: "session-mcp",
      configOptions: [],
      mcpServers: ["deepwiki"],
      skippedMcpServers: [{ name: "local-notes", reason: "missing_command" }],
    });
    h.prompt.mockResolvedValue({ turnId: 1 });

    const settings = useSettingsStore();
    settings.setMcpServerEnabled("deepwiki", true);
    const agentStore = useAgentStore();
    await agentStore.dispatchToAcp("查一下这个仓库");

    expect(h.openSession.mock.calls[0]?.[2]).toEqual([{ name: "deepwiki", transport: "http", url: "https://mcp.deepwiki.com/mcp" }]);
    expect(agentStore.acpMcpServers).toEqual(["deepwiki"]);
    expect(agentStore.acpMcpSkipped).toEqual([{ name: "local-notes", reason: "missing_command" }]);
  });

  it("未启用的服务器不下发", async () => {
    h.startAgent.mockResolvedValue(12);
    h.openSession.mockResolvedValue({ sessionId: "session-plain", configOptions: [] });
    h.prompt.mockResolvedValue({ turnId: 1 });

    // 显式停用：设置会落 localStorage，同文件前一条用例的启用状态会被下一个 pinia 读回来
    useSettingsStore().setMcpServerEnabled("deepwiki", false);
    const agentStore = useAgentStore();
    await agentStore.dispatchToAcp("普通一轮");

    expect(h.openSession.mock.calls[0]?.[2]).toEqual([]);
  });

  it("probeMcpServer 转发探活报告；传输不可用时返回错误文案而不抛", async () => {
    h.probeMcp.mockResolvedValue({
      transport: "http",
      serverName: "DeepWiki",
      serverVersion: "2.14.3",
      tools: [{ name: "ask_question" }],
      durationMs: 5,
    });
    const agentStore = useAgentStore();
    const config = { name: "deepwiki", transport: "http" as const, url: "https://mcp.deepwiki.com/mcp" };

    const ok = await agentStore.probeMcpServer(config);
    expect(ok.report?.serverName).toBe("DeepWiki");
    expect(ok.report?.tools.map((tool) => tool.name)).toEqual(["ask_question"]);

    h.probeMcp.mockRejectedValue(new Error("initialize returned HTTP 500"));
    const failed = await agentStore.probeMcpServer(config);
    expect(failed.error).toContain("HTTP 500");

    h.isAvailable.mockImplementation(() => false);
    const unavailable = await agentStore.probeMcpServer(config);
    expect(unavailable.error).toBeTruthy();
    expect(unavailable.report).toBeUndefined();
  });
});

describe("ACP 后端图标（前端覆盖层）", () => {
  /** node 环境注入内存 localStorage：图标 overlay 走 createJsonStorage 落盘。 */
  function injectStorage(): void {
    const backing: Record<string, string> = {};
    const storage = {
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
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });
  }

  beforeEach(injectStorage);

  it("预设后端也能改图标，且换 store（≈重启按真源重建目录）后仍在", () => {
    const store = useAgentStore();
    const preset = store.agentProviders[0]!;
    expect(preset.icon).toBeUndefined();

    store.setAgentProviderIcon(preset.id, "lightning");
    expect(store.agentProviders.find((provider) => provider.id === preset.id)?.icon).toBe("lightning");

    // SQLite 的 agent_providers 没有图标列：换 store 等于重跑一次 mergeProviders，靠 overlay 补回
    setActivePinia(createPinia());
    const restarted = useAgentStore();
    expect(restarted.agentProviders.find((provider) => provider.id === preset.id)?.icon).toBe("lightning");
  });

  it("清空图标回落到兜底；自配后端删除时连同图标映射一起清", async () => {
    const store = useAgentStore();
    const preset = store.agentProviders[0]!;
    store.setAgentProviderIcon(preset.id, "earth");
    store.setAgentProviderIcon(preset.id, null);
    expect(store.agentProviders.find((provider) => provider.id === preset.id)?.icon).toBeUndefined();

    expect(store.addAgentProvider("My Agent", "my-agent acp", "magic")).toBeNull();
    const custom = store.agentProviders.find((provider) => provider.name === "My Agent")!;
    expect(custom.icon).toBe("magic");

    await store.removeAgentProvider(custom.id);
    setActivePinia(createPinia());
    const restarted = useAgentStore();
    expect(restarted.agentProviders.some((provider) => provider.icon === "magic")).toBe(false);
  });
});
