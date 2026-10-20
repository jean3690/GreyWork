// 协议层子代理（ACP subagent_update / session_message）契约：
// 归属树、状态与通知、自身流量不泄漏主会话、早到流量缓冲、会话间消息。
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
  cancelSession: vi.fn(),
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
      probeMcp: (config: unknown) => h.probeMcp(config),
      setSessionConfig: (handle: number, configId: string, value: string | boolean) => h.setSessionConfig(handle, configId, value),
      setPermissionTier: (handle: number, tier: string) => h.setPermissionTier(handle, tier),
      prompt: (handle: number, text: string) => h.prompt(handle, text),
      stop: (handle: number, turnId?: number) => h.stop(handle, turnId),
      cancelSession: (handle: number, sessionId: string) => h.cancelSession(handle, sessionId),
      respondPermission: (requestId: number, optionId: string | null) => h.respondPermission(requestId, optionId),
      onEvent: (listener: (event: AcpEventEnvelope) => void) => {
        h.listener = listener;
        return Promise.resolve(() => undefined);
      },
    }) as never,
  desktopHomeDir: () => h.homeDir(),
}));
vi.mock("@/lib/workspace-dir", () => ({
  resolveWorkspaceDir: async () => "/home/test",
  isolateForRun: async (base: string) => base,
}));

import { useAgentStore } from "@/stores/agent";
import { useChatStore } from "@/stores/chat";
import { useNoticeStore } from "@/stores/notice";
import { useSessionStore } from "@/stores/session";

function emit(event: AcpEventEnvelope): void {
  expect(h.listener).not.toBeNull();
  h.listener?.(event);
}

/** 建立一条 ACP 会话并让事件监听就绪（主会话 id = session-1）。 */
async function connect(): Promise<ReturnType<typeof useAgentStore>> {
  h.startAgent.mockResolvedValue(7);
  h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [] });
  h.prompt.mockResolvedValue({ turnId: 1 });
  const agentStore = useAgentStore();
  const chat = useChatStore();
  useSessionStore().createSession(null, "子代理测试");
  chat.activeThreadId = useSessionStore().activeSessionId!;
  await agentStore.dispatchToAcp("测试子代理");
  return agentStore;
}

function announce(childSessionId: string, extra: Record<string, unknown> = {}): AcpEventEnvelope {
  return {
    kind: "session-update",
    payload: { sessionId: "session-1", update: { sessionUpdate: "subagent_update", sessionId: childSessionId, ...extra } },
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  h.isAvailable.mockImplementation(() => true);
  h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
  h.listener = null;
});

describe("协议层子代理", () => {
  it("subagent_update 宣告子代理：入列表并记录 running 状态", async () => {
    const agent = await connect();
    emit(announce("child-1", { title: "调查失败原因", state: { state: "running" } }));
    expect(agent.protocolSubagents).toHaveLength(1);
    expect(agent.protocolSubagents[0]?.sessionId).toBe("child-1");
    expect(agent.protocolSubagents[0]?.title).toBe("调查失败原因");
    expect(agent.protocolSubagents[0]?.state?.state).toBe("running");
  });

  it("子代理从 running 转 idle：发一次成功通知（按 stopReason 区分取消/出错）", async () => {
    const agent = await connect();
    const notices = useNoticeStore();
    emit(announce("child-1", { title: "调查", state: { state: "running" } }));
    emit(announce("child-1", { state: { state: "idle", stopReason: "end_turn" } }));
    expect(notices.list.some((notice) => notice.kind === "success" && notice.title.includes("调查"))).toBe(true);

    emit(announce("child-2", { title: "跑测试", state: { state: "running" } }));
    emit(announce("child-2", { state: { state: "idle", stopReason: "error", error: "boom" } }));
    expect(notices.list.some((notice) => notice.kind === "error" && notice.title.includes("跑测试"))).toBe(true);

    emit(announce("child-3", { title: "被停的", state: { state: "running" } }));
    emit(announce("child-3", { state: { state: "idle", stopReason: "cancelled" } }));
    expect(notices.list.some((notice) => notice.kind === "info" && notice.title.includes("被停的"))).toBe(true);
    expect(agent.protocolSubagents).toHaveLength(3);
  });

  it("空闲后重复 idle 快照不重复通知；重新开工后再收工才有第二次通知", async () => {
    const agent = await connect();
    const notices = useNoticeStore();
    emit(announce("child-1", { title: "复用", state: { state: "running" } }));
    emit(announce("child-1", { state: { state: "idle", stopReason: "end_turn" } }));
    expect(notices.list.some((notice) => notice.title.includes("复用"))).toBe(true);

    notices.clear();
    // 幂等的 idle 快照重放：不应再通知（无 running 过渡）
    emit(announce("child-1", { state: { state: "idle", stopReason: "end_turn" } }));
    expect(notices.list.some((notice) => notice.title.includes("复用"))).toBe(false);

    // 重新开工 → 再收工：第二次通知放行
    emit(announce("child-1", { state: { state: "running" } }));
    emit(announce("child-1", { state: { state: "idle", stopReason: "end_turn" } }));
    expect(notices.list.some((notice) => notice.title.includes("复用"))).toBe(true);
    expect(agent.protocolSubagents[0]?.state?.state).toBe("idle");
  });

  it("子代理自身正文/工具不写入主会话支架（隔离）", async () => {
    const agent = await connect();
    const chat = useChatStore();
    const scaffold = chat.threads[chat.activeThreadId]?.at(-1);
    emit(announce("child-1", { title: "子", state: { state: "running" } }));
    emit({
      kind: "session-update",
      payload: { sessionId: "child-1", update: { sessionUpdate: "agent_message_chunk", content: { text: "子代理的输出" } } },
    });
    emit({
      kind: "session-update",
      payload: {
        sessionId: "child-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Read",
          kind: "read",
          status: "completed",
          locations: [{ path: "/a.ts" }],
        },
      },
    });
    chat.flushPendingContent();
    expect(scaffold?.content ?? "").not.toContain("子代理的输出");
    expect(agent.protocolSubagents[0]?.lastText).toContain("子代理的输出");
    expect(agent.protocolSubagents[0]?.toolCount).toBe(1);
  });

  it("早到流量（宣告前先到）：先缓冲、宣告后归属，不泄漏主会话", async () => {
    const agent = await connect();
    const chat = useChatStore();
    const scaffold = chat.threads[chat.activeThreadId]?.at(-1);
    // 宣告之前先来子会话 chunk：应被缓冲而非写入主会话
    emit({
      kind: "session-update",
      payload: { sessionId: "child-9", update: { sessionUpdate: "agent_message_chunk", content: { text: "早到的输出" } } },
    });
    chat.flushPendingContent();
    expect(scaffold?.content ?? "").not.toContain("早到的输出");
    // 宣告到达：缓冲回放，归属到子代理
    emit(announce("child-9", { title: "迟宣告", state: { state: "running" } }));
    expect(agent.protocolSubagents[0]?.lastText).toContain("早到的输出");
    expect(scaffold?.content ?? "").not.toContain("早到的输出");
  });

  it("session_message / session_message_chunk 归入会话间消息，不当作对用户的回答", async () => {
    const agent = await connect();
    const chat = useChatStore();
    const scaffold = chat.threads[chat.activeThreadId]?.at(-1);
    emit(announce("child-1", { title: "子", state: { state: "running" } }));
    emit({
      kind: "session-update",
      payload: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "session_message_chunk",
          messageId: "m1",
          recipientSessionId: "child-1",
          content: { type: "text", text: "去查一下" },
        },
      },
    });
    emit({
      kind: "session-update",
      payload: {
        sessionId: "session-1",
        update: { sessionUpdate: "session_message_chunk", messageId: "m1", content: { type: "text", text: "那个失败" } },
      },
    });
    chat.flushPendingContent();
    expect(scaffold?.content ?? "").not.toContain("去查一下");
    // chunk 追加语义：同 messageId 累加
    expect(agent.subagentMessagesOf("session-1")[0]?.text).toBe("去查一下那个失败");
  });

  it("自引用 / 循环归属被防御性忽略", async () => {
    const agent = await connect();
    emit(announce("session-1")); // child === parent：忽略
    expect(agent.protocolSubagents).toHaveLength(0);
  });

  it("嵌套：子代理可再宣告孙代理，深度逐层递增", async () => {
    const agent = await connect();
    emit(announce("child-a", { state: { state: "running" } }));
    // child-a 作为父再宣告 child-b（outer sessionId = child-a）
    emit({
      kind: "session-update",
      payload: { sessionId: "child-a", update: { sessionUpdate: "subagent_update", sessionId: "child-b", state: { state: "running" } } },
    });
    expect(agent.protocolSubagents.map((child) => child.sessionId)).toEqual(["child-a", "child-b"]);
    expect(agent.subagentDepthOf("child-a")).toBe(1);
    expect(agent.subagentDepthOf("child-b")).toBe(2);
    expect(agent.subagentDepthOf("not-announced")).toBe(0);
  });

  it("自身转录可读（正文 + 工具计数）", async () => {
    const agent = await connect();
    emit(announce("child-1", { title: "子", state: { state: "running" } }));
    emit({
      kind: "session-update",
      payload: { sessionId: "child-1", update: { sessionUpdate: "agent_message_chunk", content: { text: "子代理思考中" } } },
    });
    const transcript = agent.subagentTranscriptOf("child-1");
    expect(transcript?.text).toContain("子代理思考中");
    expect(transcript?.tools).toEqual([]);
  });

  it("cancelSubagent：仅对宣告了 capabilities.cancel 的子代理发出 session/cancel", async () => {
    const agent = await connect();
    emit(announce("with-cancel", { title: "可停", capabilities: { cancel: {} }, state: { state: "running" } }));
    emit(announce("no-cancel", { title: "不可停", state: { state: "running" } }));
    expect(await agent.cancelSubagent("no-cancel")).toBe(false);
    expect(h.cancelSession).not.toHaveBeenCalled();
    expect(await agent.cancelSubagent("with-cancel")).toBe(true);
    expect(h.cancelSession).toHaveBeenCalledWith(7, "with-cancel");
  });

  it("宣告迟迟不来：早到缓冲到期回落到主会话（不静默吞事件）", async () => {
    const agent = await connect();
    const chat = useChatStore();
    const scaffold = chat.threads[chat.activeThreadId]?.at(-1);
    vi.useFakeTimers();
    try {
      emit({
        kind: "session-update",
        payload: { sessionId: "orphan-1", update: { sessionUpdate: "agent_message_chunk", content: { text: "孤儿输出" } } },
      });
      chat.flushPendingContent();
      // 缓冲期：还不写主会话
      expect(scaffold?.content ?? "").not.toContain("孤儿输出");
      expect(agent.protocolSubagents).toHaveLength(0);
      // 到期回落：整批交回主会话
      vi.advanceTimersByTime(2500);
      chat.flushPendingContent();
      expect(scaffold?.content ?? "").toContain("孤儿输出");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stopped 回收会话时清空子代理树", async () => {
    const agent = await connect();
    emit(announce("child-1", { state: { state: "running" } }));
    expect(agent.protocolSubagents).toHaveLength(1);
    emit({ kind: "stopped", payload: { handle: 7 } });
    expect(agent.protocolSubagents).toHaveLength(0);
  });
});
