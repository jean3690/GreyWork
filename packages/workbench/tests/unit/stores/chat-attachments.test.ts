// 附件在消息流里的保真：submitText / startAcpTurn / 计划门都要把附件原样带进消息。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import type { Attachment } from "@/types";

function attachment(id: string, kind: "image" | "text" = "image"): Attachment {
  return { id, kind, name: `${id}.png`, mime: "image/png", size: 4, path: `/tmp/${id}.png` };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

// mock 演示管线的 sim 定时器归 chat store 管，测完清掉避免残留。
afterEach(() => {
  useChatStore().clearSim();
});

describe("chat 附件保真", () => {
  it("submitText 把附件写进 user 消息", () => {
    const chat = useChatStore();
    const sessionStore = useSessionStore();
    const threadId = sessionStore.createSession(null).id;
    chat.activeThreadId = threadId;

    const message = chat.submitText("看下这张图", [attachment("att-1"), attachment("att-2", "text")]);
    const messages = sessionStore.getSession(threadId)?.messages ?? [];
    const user = messages.find((item) => item.role === "user");
    expect(user?.content).toBe("看下这张图");
    expect(user?.attachments).toEqual([attachment("att-1"), attachment("att-2", "text")]);
    expect(message?.attachments ?? []).toEqual([]); // 脚手架消息不带附件
  });

  it("计划模式下附件挂在脚手架消息的 planAttachments 上", () => {
    const settings = useSettingsStore();
    settings.planMode = true;
    const chat = useChatStore();
    const sessionStore = useSessionStore();
    const threadId = sessionStore.createSession(null).id;
    chat.activeThreadId = threadId;

    const pending = chat.submitText("先规划", [attachment("att-9")]);
    expect(pending?.planPending).toBe(true);
    expect(pending?.planAttachments).toEqual([attachment("att-9")]);
    // 取消计划：卡片被摘掉，附件随卡片一起消失（不残留、也不派发）
    chat.cancelPlan(threadId, pending!);
    expect(sessionStore.getSession(threadId)?.messages.some((item) => item.id === pending!.id)).toBe(false);
  });

  it("startAcpTurn 把附件写进 user 消息", () => {
    const chat = useChatStore();
    const sessionStore = useSessionStore();
    const threadId = sessionStore.createSession(null).id;
    chat.activeThreadId = threadId;

    const { message } = chat.startAcpTurn("交给 agent", "opencode", [attachment("att-3")]);
    const messages = sessionStore.getSession(threadId)?.messages ?? [];
    expect(messages.find((item) => item.role === "user")?.attachments).toEqual([attachment("att-3")]);
    expect(message.acp).toBe("opencode");
  });

  it("只发附件不带文字也能入流（截图问答）", () => {
    const chat = useChatStore();
    const sessionStore = useSessionStore();
    const threadId = sessionStore.createSession(null).id;
    chat.activeThreadId = threadId;

    expect(chat.submitText("", [])).toBeNull(); // 两样都空：照旧拒绝
    const message = chat.submitText("", [attachment("att-only")]);
    expect(message).not.toBeNull();
    const user = (sessionStore.getSession(threadId)?.messages ?? []).find((item) => item.role === "user");
    expect(user?.content).toBe("");
    expect(user?.attachments).toEqual([attachment("att-only")]);
  });

  it("startAcpTurn 允许空正文 + 附件", () => {
    const chat = useChatStore();
    const sessionStore = useSessionStore();
    const threadId = sessionStore.createSession(null).id;
    chat.activeThreadId = threadId;

    chat.startAcpTurn("", "opencode", [attachment("att-5")]);
    const user = (sessionStore.getSession(threadId)?.messages ?? []).find((item) => item.role === "user");
    expect(user?.content).toBe("");
    expect(user?.attachments).toEqual([attachment("att-5")]);
  });

  it("enqueueCommand 保留附件，补发时带进消息", () => {
    const chat = useChatStore();
    const sessionStore = useSessionStore();
    const threadId = sessionStore.createSession(null).id;
    chat.activeThreadId = threadId;

    chat.enqueueCommand("稍后发", [attachment("att-4")]);
    chat.sendCommand(chat.commandQueue[0].id);
    expect(sessionStore.getSession(threadId)?.messages.find((item) => item.role === "user")?.attachments).toEqual([attachment("att-4")]);
  });
});
