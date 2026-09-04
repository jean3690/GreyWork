// M5 发送队列：入队 / 移除 / 清空 / 手动补发 / auto 回合结束自动补发。
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { useChatStore } from "@/stores/chat";

describe("chat 发送队列（M5）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("enqueue / remove / clear 维护队列", () => {
    const chat = useChatStore();
    chat.enqueueCommand("第一条");
    chat.enqueueCommand("第二条", ["a.png"]);
    expect(chat.commandQueue.length).toBe(2);
    expect(chat.commandQueue[1].attachments).toEqual(["a.png"]);

    chat.removeCommand(chat.commandQueue[0].id);
    expect(chat.commandQueue.length).toBe(1);
    expect(chat.commandQueue[0].input).toBe("第二条");

    chat.clearQueue();
    expect(chat.commandQueue.length).toBe(0);
  });

  it("toggleQueueMode 在 auto/manual 间切换", () => {
    const chat = useChatStore();
    expect(chat.commandQueueMode).toBe("auto");
    chat.toggleQueueMode();
    expect(chat.commandQueueMode).toBe("manual");
    chat.toggleQueueMode();
    expect(chat.commandQueueMode).toBe("auto");
  });

  it("空闲时 sendCommand 出队并提交消息", () => {
    const chat = useChatStore();
    chat.enqueueCommand("补发任务");
    const id = chat.commandQueue[0].id;
    chat.sendCommand(id);
    expect(chat.commandQueue.length).toBe(0);
    // submitText 立即入流 user 消息（无 LLM → mock 管线同步置 busy）
    const thread = chat.threads[chat.activeThreadId];
    expect(thread?.some((m) => m.role === "user" && m.content === "补发任务")).toBe(true);
    chat.clearSim();
    chat.busy = false;
  });

  it("busy 时 sendCommand 重新入队（不打断当前回合）", () => {
    const chat = useChatStore();
    chat.commandQueueMode = "manual"; // 防 auto 兜底 drain 干扰
    chat.enqueueCommand("待命指令");
    const id = chat.commandQueue[0].id;
    chat.busy = true;
    chat.sendCommand(id);
    expect(chat.commandQueue.length).toBe(1);
    expect(chat.commandQueue[0].id).toBe(id);
    chat.busy = false;
  });

  it("auto 模式：busy→false 时自动补发队首一条", async () => {
    const chat = useChatStore();
    chat.enqueueCommand("自动补发");
    chat.busy = true;
    chat.busy = false;
    await nextTick();
    expect(chat.commandQueue.length).toBe(0);
    const thread = chat.threads[chat.activeThreadId];
    expect(thread?.some((m) => m.role === "user" && m.content === "自动补发")).toBe(true);
    chat.clearSim();
    chat.busy = false;
  });

  it("manual 模式：busy→false 不自动补发", async () => {
    const chat = useChatStore();
    chat.commandQueueMode = "manual";
    chat.enqueueCommand("手动等发");
    chat.busy = true;
    chat.busy = false;
    await nextTick();
    expect(chat.commandQueue.length).toBe(1);
    chat.busy = false;
  });
});
