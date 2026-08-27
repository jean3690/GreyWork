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
    setSessionConfig: (handle: number, configId: string, value: string | boolean) =>
      h.setSessionConfig(handle, configId, value),
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
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "mock/fast", options: [{ value: "mock/fast" }, { value: "mock/slow" }] }] });
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
    expect(chat.threads[chat.activeThreadId]?.at(-1)?.content).toContain("[权限回传失败] Error: closed");

    turn.resolve({});
    await pending;
  });
});
describe("会话配置选择器（session/set_config_option）", () => {
  it("启动会话后暴露 configOptions，setAcpConfig 回写最新选项", async () => {
    h.startAgent.mockResolvedValue(7);
    h.openSession.mockResolvedValue({
      sessionId: "session-1",
      configOptions: [
        { id: "model", name: "Model", category: "model", type: "select", currentValue: "mock/fast", options: [{ value: "mock/fast", name: "Fast" }, { value: "mock/slow", name: "Slow" }] },
      ],
    });
    const latest = [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "mock/slow", options: [{ value: "mock/fast", name: "Fast" }, { value: "mock/slow", name: "Slow" }] },
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
    h.openSession.mockResolvedValue({ sessionId: "session-1", configOptions: [{ id: "effort", name: "Effort", type: "select", currentValue: "high", options: [{ value: "high" }] }] });
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
