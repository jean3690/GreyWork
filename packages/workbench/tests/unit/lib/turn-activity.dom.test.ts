/**
 * useTurnActive：四个 store 字段（chat.busy / acpBusy / acpConnecting / acpStatus）
 * 任一命中即为活跃。这层的价值就在于**没有第五个字段漏在外面** —— 所以要逐字段验。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useChatStore } from "@/stores/chat";
import { useAgentStore } from "@/stores/agent";
import { useTurnActive } from "@/lib/turn-activity";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@greywork/acp", () => ({
  createAcpClient: () => ({ isAvailable: () => true, onEvent: () => Promise.resolve(() => undefined) }) as never,
  desktopHomeDir: () => Promise.resolve("/home/test"),
}));

function seed() {
  setActivePinia(createPinia());
  return { chat: useChatStore(), agent: useAgentStore(), turnActive: useTurnActive() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useTurnActive", () => {
  it("全部空闲 = false", () => {
    const { turnActive } = seed();
    expect(turnActive.value).toBe(false);
  });

  it.each([
    ["本地 LLM 流在跑", (s: ReturnType<typeof seed>) => (s.chat.busy = true)],
    ["ACP 回合在跑", (s: ReturnType<typeof seed>) => (s.agent.acpBusy = true)],
    ["ACP 建会话中", (s: ReturnType<typeof seed>) => (s.agent.acpConnecting = true)],
    ["状态机处于 connecting", (s: ReturnType<typeof seed>) => (s.agent.acpStatus = "connecting")],
  ])("%s → true", (_label, mutate) => {
    const state = seed();
    mutate(state);
    expect(state.turnActive.value).toBe(true);
  });

  it("connected / session_active 等非在途状态不算活跃", () => {
    const state = seed();
    state.agent.acpStatus = "session_active";
    state.agent.acpConnected = true;
    expect(state.turnActive.value).toBe(false);
  });
});
