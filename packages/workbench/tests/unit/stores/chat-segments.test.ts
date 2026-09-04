/**
 * 消息段落契约：一条助手消息按到达顺序分段（思考 / 正文 / 工具），
 * 渲染层据此实现「每段思考各自折叠」与「工具批次就地展开」。
 *
 * 重点是顺序与边界：正文增量走 ~40ms 缓冲，思考与工具插进来时必须先把缓冲落地，
 * 否则先到的正文会排到后到的思考之后（段序错位、正文被吞）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import type { ToolActivity } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function seedAssistant() {
  const chat = useChatStore();
  const session = useSessionStore().createSession(null, "段落测试");
  chat.activeThreadId = session.id;
  const { message } = chat.startAcpTurn("问题", "opencode");
  return { chat, message };
}

function tool(partial: Partial<ToolActivity> & { toolCallId: string }): ToolActivity {
  return { kind: "read", status: "completed", startedAt: 1, finishedAt: 2, ...partial };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("消息段落", () => {
  it("思考 → 正文 → 思考：三段各自成段，正文只存一份", () => {
    const { chat, message } = seedAssistant();
    chat.appendMessageThinking(message.id, "先看清");
    chat.appendMessageThinking(message.id, "再动手");
    chat.appendMessageContent(message.id, "答案上半");
    chat.appendMessageContent(message.id, "答案下半");
    chat.flushPendingContent();
    chat.appendMessageThinking(message.id, "复核");

    const segments = message.segments ?? [];
    expect(segments.map((segment) => segment.kind)).toEqual(["thinking", "text", "thinking"]);
    expect(segments[0]).toMatchObject({ kind: "thinking", text: "先看清再动手" });
    expect(segments[1]).toMatchObject({ kind: "text", from: 0, to: 8 });
    expect(segments[2]).toMatchObject({ kind: "thinking", text: "复核" });
    expect(message.content).toBe("答案上半答案下半");
  });

  it("思考段被打断即封口：endedAt 记最后一次增量，时长可算", () => {
    const { chat, message } = seedAssistant();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    chat.appendMessageThinking(message.id, "推理");
    vi.setSystemTime(new Date(1_002_500));
    chat.appendMessageThinking(message.id, "继续");
    const [segment] = message.segments ?? [];
    expect(segment?.kind === "thinking" && segment.endedAt - segment.startedAt).toBe(2500);
    vi.useRealTimers();
  });

  it("缓冲中的正文先落地，再插思考：段序不错位", () => {
    const { chat, message } = seedAssistant();
    chat.appendMessageContent(message.id, "先说一句");
    // 不显式 flush：思考写入内部会先把缓冲落地
    chat.appendMessageThinking(message.id, "再想想");
    chat.appendMessageContent(message.id, "补一句");
    chat.flushPendingContent();

    const segments = message.segments ?? [];
    expect(segments.map((segment) => segment.kind)).toEqual(["text", "thinking", "text"]);
    expect(segments[0]).toMatchObject({ from: 0, to: 4 });
    expect(segments[2]).toMatchObject({ from: 4, to: null });
    expect(message.content).toBe("先说一句补一句");
  });

  it("连续工具调用归一个工具段；后续同 id 的 update 不再另起段", () => {
    const { chat, message } = seedAssistant();
    chat.appendTools([tool({ toolCallId: "a", status: "in_progress", finishedAt: null })], message.id);
    chat.appendTools([tool({ toolCallId: "b", status: "in_progress", finishedAt: null })], message.id);
    chat.appendTools([tool({ toolCallId: "a", status: "completed" })], message.id);

    const segments = message.segments ?? [];
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: "tools", toolCallIds: ["a", "b"] });
    expect(message.tools).toHaveLength(2);
  });

  it("正文之后的新工具调用另起工具段（保真「答话 → 又动手」）", () => {
    const { chat, message } = seedAssistant();
    chat.appendTools([tool({ toolCallId: "a" })], message.id);
    chat.appendMessageContent(message.id, "阶段结论");
    chat.flushPendingContent();
    chat.appendTools([tool({ toolCallId: "b" })], message.id);

    expect((message.segments ?? []).map((segment) => segment.kind)).toEqual(["tools", "text", "tools"]);
  });

  it("正文整体替换（错误兜底）：思考与工具段保留，正文归一段挂到末尾", () => {
    const { chat, message } = seedAssistant();
    chat.appendMessageThinking(message.id, "推理");
    chat.appendMessageContent(message.id, "半句");
    chat.flushPendingContent();
    chat.setMessageContent(message.id, "[已停止]");

    const segments = message.segments ?? [];
    expect(segments.map((segment) => segment.kind)).toEqual(["thinking", "text"]);
    expect(segments[1]).toMatchObject({ from: 0, to: null });
    expect(message.content).toBe("[已停止]");
  });
});
