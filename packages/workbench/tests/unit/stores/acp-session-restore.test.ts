// ACP 会话惰性恢复契约：绑定存在且 provider/cwd 一致 → session/load 接回旧上下文；
// 任何不匹配/失败都静默回落 session/new，保证「发送必达」；恢复窗口内重放内容被抑制。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { AcpEventEnvelope } from "@greywork/acp";

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
  homeDir: vi.fn<() => Promise<string | null>>(() => Promise.resolve("/home/test")),
  listener: null as ((event: AcpEventEnvelope) => void) | null,
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
      onEvent: (listener: (event: AcpEventEnvelope) => void) => {
        h.listener = listener;
        return Promise.resolve(() => undefined);
      },
    }) as never,
  desktopHomeDir: () => h.homeDir(),
}));

import { useAgentStore } from "@/stores/agent";
import { useChatStore } from "@/stores/chat";
import { useNoticeStore } from "@/stores/notice";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";

const storageHolder = globalThis as { localStorage?: Storage };

/** node 环境注入内存 localStorage（会话/偏好持久化走 createJsonStorage）。 */
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

beforeEach(() => {
  setActivePinia(createPinia());
  // ACP 建会话要解析工作区：node 环境非 Tauri 运行时，设置项为空则 resolveWorkspaceDir 抛错。
  useSettingsStore().workspaceDir = "/home/test";
  vi.clearAllMocks();
  injectStorage();
  h.isAvailable.mockImplementation(() => true);
  h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
  h.listener = null;
  h.startAgent.mockResolvedValue(7);
  h.openSession.mockResolvedValue({ sessionId: "new-session", configOptions: [] });
  h.loadSession.mockResolvedValue({ sessionId: "acp-old-1", configOptions: [], restored: true });
  h.prompt.mockResolvedValue({ turnId: 1 });
});

/** 建一条带 ACP 绑定的会话并置为当前；返回默认选中 provider 的 id。 */
function bindCurrentSession(): string {
  const sessionStore = useSessionStore();
  const agentStore = useAgentStore();
  const providerId = agentStore.agentProviders[0]?.id ?? "";
  const session = sessionStore.createSession(null, "恢复会话");
  sessionStore.setAcpBinding(session.id, {
    sessionId: "acp-old-1",
    providerId,
    cwd: "/home/test",
    savedAt: Date.now(),
  });
  return providerId;
}

describe("ACP 会话惰性恢复", () => {
  it("绑定存在且 provider/cwd 一致 → 走 loadSession，不调 openSession", async () => {
    bindCurrentSession();
    const agentStore = useAgentStore();

    await agentStore.dispatchToAcp("接着上一轮干");

    expect(h.loadSession).toHaveBeenCalledWith(7, "/home/test", "acp-old-1", []);
    expect(h.openSession).not.toHaveBeenCalled();
    expect(h.prompt).toHaveBeenCalledWith(7, "接着上一轮干");
    // 恢复出的会话已接管（connected：configOptions 为空不升 session_active）
    expect(agentStore.acpConnected).toBe(true);
    expect(agentStore.acpStatus).toBe("connected");
    // 同一对话内再发一轮：回合收尾后，会话已绑定该对话，不再触发任何建会话路径
    emit({ kind: "prompt-done", payload: { turnId: 1, response: {} } });
    await agentStore.dispatchToAcp("再来一轮");
    expect(h.loadSession).toHaveBeenCalledTimes(1);
    expect(h.openSession).not.toHaveBeenCalled();
    expect(h.prompt).toHaveBeenCalledTimes(2);
  });

  it("providerId 不匹配 → 回落 openSession（新建），不调 loadSession", async () => {
    const sessionStore = useSessionStore();
    const agentStore = useAgentStore();
    const session = sessionStore.createSession(null, "换后端会话");
    sessionStore.setAcpBinding(session.id, {
      sessionId: "acp-other-provider",
      providerId: "some-other-provider",
      cwd: "/home/test",
      savedAt: Date.now(),
    });

    await agentStore.dispatchToAcp("从头开始");

    expect(h.loadSession).not.toHaveBeenCalled();
    expect(h.openSession).toHaveBeenCalledWith(7, "/home/test", []);
    expect(h.prompt).toHaveBeenCalledWith(7, "从头开始");
  });

  it("cwd 不一致（工作区换了）→ 回落 openSession", async () => {
    const sessionStore = useSessionStore();
    const agentStore = useAgentStore();
    const providerId = agentStore.agentProviders[0]?.id ?? "";
    const session = sessionStore.createSession(null, "换工作区");
    sessionStore.setAcpBinding(session.id, {
      sessionId: "acp-old-dir",
      providerId,
      cwd: "/home/other/proj",
      savedAt: Date.now(),
    });

    await agentStore.dispatchToAcp("开始");

    expect(h.loadSession).not.toHaveBeenCalled();
    expect(h.openSession).toHaveBeenCalledWith(7, "/home/test", []);
  });

  it("无绑定 → 走 openSession（既有行为不变）", async () => {
    useSessionStore().createSession(null, "新对话");
    const agentStore = useAgentStore();

    await agentStore.dispatchToAcp("你好");

    expect(h.loadSession).not.toHaveBeenCalled();
    expect(h.openSession).toHaveBeenCalledTimes(1);
  });

  it("loadSession 失败 → 静默回落 openSession，不产生错误通知（发送必达）", async () => {
    h.loadSession.mockRejectedValue(new Error("agent does not support session/load"));
    bindCurrentSession();
    const agentStore = useAgentStore();
    const noticeStore = useNoticeStore();

    await agentStore.dispatchToAcp("继续");

    expect(h.openSession).toHaveBeenCalledWith(7, "/home/test", []);
    expect(h.prompt).toHaveBeenCalledWith(7, "继续");
    expect(noticeStore.list.some((notice) => notice.kind === "error")).toBe(false);
    const list = useChatStore().threads[useChatStore().activeThreadId] ?? [];
    expect(list[1]?.content ?? "").not.toContain("启动失败");
  });

  it("load 成功后绑定落盘：重建 store 后同一会话再派发仍走 loadSession", async () => {
    bindCurrentSession();
    const agentStore = useAgentStore();
    await agentStore.dispatchToAcp("第一轮");
    expect(h.loadSession).toHaveBeenCalledTimes(1);

    // 模拟重启：同一 localStorage 上重建全部 store
    setActivePinia(createPinia());
    useSettingsStore().workspaceDir = "/home/test";
    const reloadedAgent = useAgentStore();
    await reloadedAgent.dispatchToAcp("重启后的第二轮");

    expect(h.loadSession).toHaveBeenCalledWith(7, "/home/test", "acp-old-1", []);
    expect(h.loadSession).toHaveBeenCalledTimes(2);
    expect(h.openSession).not.toHaveBeenCalled();
    expect(h.prompt).toHaveBeenCalledWith(7, "重启后的第二轮");
  });
});

describe("恢复会话的重放抑制", () => {
  it("load 后静默窗口内的 agent_message_chunk 被丢弃，不重复渲染历史", async () => {
    vi.useFakeTimers();
    try {
      bindCurrentSession();
      const agentStore = useAgentStore();
      const chat = useChatStore();

      const pending = agentStore.dispatchToAcp("继续");
      // 只刷微任务（不推进定时器）：startAgent/loadSession 均为 resolved mock，
      // 刷完后 settleReplay 已置守卫、首个 50ms tick 尚未触发。
      for (let i = 0; i < 16; i += 1) await Promise.resolve();
      expect(h.loadSession).toHaveBeenCalledTimes(1);

      // 重放：agent 把历史正文又吐了一遍 —— 窗口内必须被吞掉
      emit({
        kind: "session-update",
        payload: { update: { sessionUpdate: "agent_message_chunk", content: { text: "历史正文重放" } } },
      });
      // 推进 350ms：静默窗口结束，settleReplay 解除守卫，dispatch 继续到 prompt
      await vi.advanceTimersByTimeAsync(350);
      await pending;

      const list = chat.threads[chat.activeThreadId] ?? [];
      const assistant = list[1];
      expect(assistant?.content ?? "").not.toContain("历史正文重放");
      // prompt 之后的新输出正常写入
      emit({
        kind: "session-update",
        payload: { update: { sessionUpdate: "agent_message_chunk", content: { text: "新一轮输出" } } },
      });
      chat.flushPendingContent();
      expect(list[1]?.content).toContain("新一轮输出");
    } finally {
      vi.useRealTimers();
    }
  });

  it("窗口内的 permission-request 照常处理，不被回放抑制吞掉", async () => {
    bindCurrentSession();
    const agentStore = useAgentStore();
    const pending = agentStore.dispatchToAcp("继续");
    await vi.waitFor(() => expect(h.loadSession).toHaveBeenCalledTimes(1));

    emit({
      kind: "permission-request",
      payload: {
        requestId: 9,
        auto: false,
        chosen: null,
        toolCallId: "tc-1",
        title: "写文件",
        kind: "write",
        options: [{ optionId: "allow_once", name: "允许一次", kind: "allow_once" }],
      },
    });
    expect(agentStore.pendingPermission?.requestId).toBe(9);
    await pending;
    expect(agentStore.pendingPermission?.requestId).toBe(9);
  });
});
