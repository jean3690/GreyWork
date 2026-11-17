import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import type { LlmAgentParams, LlmChatParams, LlmEventEnvelope } from "@greywork/llm";
import { createStreamSlice } from "@/stores/chat/stream";
import type { ChatStoreState } from "@/stores/chat/state";
import type { SessionApi } from "@/stores/chat/session";
import type { DemoApi } from "@/stores/chat/demo";
import type { ThreadMessage } from "@/types";

const h = vi.hoisted(() => ({ history: vi.fn(async () => [{ role: "user", content: "question" }]) }));
vi.mock("@/stores/chat-llm", () => ({
  buildLlmHistory: h.history,
  localReasoningOverride: { value: null },
  resolveLocalEffort: () => "auto",
}));
vi.mock("@/lib/local-ai", () => ({ retrieveContext: async () => undefined, transcribeAttachment: async () => null }));
vi.mock("@/lib/workspace-dir", () => ({ resolveWorkspaceRoot: async () => ({ dir: "/work/project" }) }));

function harness(agentMode = true) {
  let listener: ((event: LlmEventEnvelope) => void) | undefined;
  const agentRun = vi.fn(async (_params: LlmAgentParams) => 42);
  const chat = vi.fn(async (_params: LlmChatParams) => 7);
  const stopAgent = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const message = { id: "answer", role: "assistant", content: "", steps: [] } as unknown as ThreadMessage;
  const state = {
    busy: ref(false),
    runningSessionId: ref(null),
    streamingMessageId: ref(null),
    llmActive: ref(false),
    sessionStore: { markDirty: vi.fn() },
    settingsStore: {
      modelProviders: [
        {
          id: "p",
          enabled: true,
          name: "custom",
          baseUrl: "https://gateway.example/openai",
          model: "custom",
          stream: false,
          extraBody: { top_p: 0.8 },
          agentMode,
        },
      ],
      selectedModelProviderId: "p",
      agentFallback: false,
      agentContextTokens: 32000,
      permissionTier: "read-only",
      enabledMcpServers: [],
    },
    llm: {
      isAvailable: () => true,
      agentRun,
      chat,
      stopAgent,
      stop,
      onEvent: async (fn: typeof listener) => {
        listener = fn;
        return () => {};
      },
    },
  } as unknown as ChatStoreState;
  const session = { activeThreadId: ref("thread"), ensure: () => [message] } as unknown as SessionApi;
  const stream = createStreamSlice({ state, getSession: () => session, getDemo: () => ({ runAssistant: vi.fn() }) as unknown as DemoApi });
  return { state, stream, message, agentRun, chat, stopAgent, stop, emit: (event: LlmEventEnvelope) => listener?.(event) };
}

beforeEach(() => {
  h.history.mockReset();
  h.history.mockResolvedValue([{ role: "user", content: "question" }]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("第三方模型流与取消", () => {
  it("供应商扩展参数进入主请求与回退链，取消立即收尾且迟到事件不再写入", async () => {
    const h = harness();
    await h.stream.dispatchAssistant(h.message);
    expect(h.agentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: false,
        extraBody: { top_p: 0.8 },
        providers: [expect.objectContaining({ stream: false, extraBody: { top_p: 0.8 } })],
      }),
    );
    const token = h.agentRun.mock.calls[0][0].clientToken;
    h.stream.abortGeneration();
    expect(h.stopAgent).toHaveBeenCalledWith(42);
    expect(h.state.busy.value).toBe(false);
    h.emit({ kind: "llm-delta", payload: { clientToken: token, delta: "late" } });
    h.stream.flushPendingContent();
    expect(h.message.content).toBe("");
  });
  it("准备上下文期间取消，不启动宿主任务", async () => {
    const gate = Promise.withResolvers<{ role: string; content: string }[]>();
    h.history.mockReturnValue(gate.promise);
    const x = harness();
    const dispatch = x.stream.dispatchAssistant(x.message);
    await vi.waitFor(() => expect(h.history).toHaveBeenCalled());
    x.stream.abortGeneration();
    gate.resolve([]);
    await dispatch;
    expect(x.agentRun).not.toHaveBeenCalled();
    expect(x.state.busy.value).toBe(false);
  });
  it("等待句柄期间取消，迟到句柄会被立即停止", async () => {
    const gate = Promise.withResolvers<number>();
    const h = harness();
    h.agentRun.mockReturnValue(gate.promise);
    const dispatch = h.stream.dispatchAssistant(h.message);
    await vi.waitFor(() => expect(h.agentRun).toHaveBeenCalled());
    h.stream.abortGeneration();
    gate.resolve(99);
    await dispatch;
    expect(h.stopAgent).toHaveBeenCalledWith(99);
    expect(h.state.busy.value).toBe(false);
  });
});
