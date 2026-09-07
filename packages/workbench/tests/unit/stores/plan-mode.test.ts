/**
 * 计划模式（本地 mock 管线）契约：submitText 挂起计划卡（steps + planDraft），
 * 确认才触发管线（intent 用计划卡的 planDraft，而非空串），取消保留用户消息。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function seed() {
  setActivePinia(createPinia());
  const chat = useChatStore();
  const session = useSessionStore().createSession(null, "计划测试");
  chat.activeThreadId = session.id;
  const settings = useSettingsStore();
  settings.planMode = true;
  return { chat, settings };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("计划模式 → 本地 mock 管线", () => {
  it("submitText：user 消息 + 挂起的计划卡（steps + planDraft），暂不派发", () => {
    const { chat } = seed();
    const pending = chat.submitText("整理周报");

    const list = chat.threads[chat.activeThreadId];
    expect(list.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(list[1]?.planPending).toBe(true);
    expect(list[1]?.planDraft).toBe("整理周报");
    expect(list[1]?.steps?.length).toBeGreaterThan(0);
    // 返回的正是挂进线程的那条（响应式代理吃掉了对象身份，比 id 即可）
    expect(pending?.id).toBe(list[1]?.id);
    expect(chat.busy).toBe(false);
  });

  it("confirmPlan：解除计划卡并以 planDraft 触发管线", () => {
    const { chat } = seed();
    const pending = chat.submitText("跑一下测试")!;
    expect(pending.planPending).toBe(true);

    chat.confirmPlan(chat.activeThreadId, pending);

    expect(pending.planPending).toBe(false);
    // mock 管线同步进入 busy（确认即执行）
    expect(chat.busy).toBe(true);
    chat.clearSim();
  });

  it("cancelPlan：摘掉计划卡，保留用户消息", () => {
    const { chat } = seed();
    const pending = chat.submitText("整理周报")!;

    chat.cancelPlan(chat.activeThreadId, pending);

    const list = chat.threads[chat.activeThreadId];
    expect(list.map((m) => m.role)).toEqual(["user"]);
    expect(chat.busy).toBe(false);
  });

  it("关闭计划模式：submitText 直接派发，无计划卡", () => {
    const { chat, settings } = seed();
    settings.planMode = false;

    chat.submitText("直接干")!;

    const list = chat.threads[chat.activeThreadId];
    expect(list.map((m) => m.role)).toEqual(["user", "assistant"]);
    // 直接派发路径同样走 runAssistant：把计划的开关位写成 false 而非 undefined
    expect(list[1]?.planPending).toBe(false);
    expect(list[1]?.planDraft).toBeUndefined();
    expect(chat.busy).toBe(true);
    chat.clearSim();
  });
});
