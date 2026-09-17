/**
 * useSessionStatus 组合式：把 store 信号（runningSessionId / busy / pendingPermission /
 * 消息里的 planPending / ask）喂进纯派生函数，逐态验证。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { useAgentStore } from "@/stores/agent";
import { useSessionStatus } from "@/lib/session-status";
import type { ThreadMessage } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@greywork/acp", () => ({
  createAcpClient: () => ({ isAvailable: () => true, onEvent: () => Promise.resolve(() => undefined) }) as never,
  desktopHomeDir: () => Promise.resolve("/home/test"),
}));

function message(partial: Partial<ThreadMessage> = {}): ThreadMessage {
  return { id: `m-${Math.random()}`, role: "assistant", content: "", ts: Date.now(), ...partial };
}

function seed() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const chat = useChatStore();
  const session = useSessionStore();
  return { chat, session, statusOf: useSessionStatus() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useSessionStatus", () => {
  it("空会话 = 未开始", () => {
    const { session, statusOf } = seed();
    const record = session.createSession(null, "空");
    expect(statusOf(record.id)).toBe("idle");
  });

  it("有消息且空闲 = 结束", () => {
    const { session, statusOf } = seed();
    const record = session.createSession(null, "完");
    record.messages.push(message({ content: "done" }));
    expect(statusOf(record.id)).toBe("done");
  });

  it("runningSessionId 命中且回合活跃 = 运行", () => {
    const { chat, session, statusOf } = seed();
    const record = session.createSession(null, "跑");
    record.messages.push(message());
    chat.runningSessionId = record.id;
    chat.busy = true;
    expect(statusOf(record.id)).toBe("running");
  });

  it("busy 但 runningSessionId 是别的会话时不误标（全局锁不能乱认）", () => {
    const { chat, session, statusOf } = seed();
    const other = session.createSession(null, "别的");
    const record = session.createSession(null, "本");
    record.messages.push(message());
    chat.runningSessionId = other.id;
    chat.busy = true;
    expect(statusOf(record.id)).toBe("done");
  });

  it("计划门挂起 = 等待中（即使回合在跑）", () => {
    const { chat, session, statusOf } = seed();
    const record = session.createSession(null, "等");
    record.messages.push(message({ planPending: true }));
    chat.runningSessionId = record.id;
    chat.busy = true;
    expect(statusOf(record.id)).toBe("waiting");
  });

  it("未作答的提问 = 等待中", () => {
    const { session, statusOf } = seed();
    const record = session.createSession(null, "问");
    record.messages.push(message({ ask: { questions: [{ question: "q", options: [{ label: "a" }] }] } }));
    expect(statusOf(record.id)).toBe("waiting");
  });

  it("已作答的提问不再算等待", () => {
    const { session, statusOf } = seed();
    const record = session.createSession(null, "答");
    record.messages.push(
      message({
        ask: { questions: [{ question: "q", options: [{ label: "a" }] }], answers: [{ question: "q", labels: ["a"] }], answeredAt: 1 },
      }),
    );
    expect(statusOf(record.id)).toBe("done");
  });

  it("权限确认挂起（属于本会话）= 等待中", () => {
    const { chat, session, statusOf } = seed();
    const agent = useAgentStore();
    const record = session.createSession(null, "权限");
    record.messages.push(message());
    chat.runningSessionId = record.id;
    chat.busy = true;
    agent.pendingPermission = { requestId: "r1", title: "写入", options: [] } as never;
    expect(statusOf(record.id)).toBe("waiting");
  });
});
