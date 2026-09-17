/**
 * 发送队列切片（M5）：回复期间下发的消息先入队，回合结束再补发。
 * auto 模式：每回合结束补发队首一条（补发会再次置 busy，天然一轮一条）；
 * flush:"sync" 使补发恰好发生在 busy 归零那一刻（回复刚结束时）。
 * sendCommand / 自动补发都需要 submitText —— 经 getSubmit() 惰性取值
 * （submit 切片不依赖本切片，无环；getter 只是保持「切片互访只走 api」的一致性）。
 */
import { watch } from "vue";
import { quid } from "./shared";
import type { Attachment } from "../../types";
import type { ChatStoreState } from "./state";
import type { SubmitApi } from "./submit";

export interface QueueDeps {
  state: ChatStoreState;
  getSubmit: () => SubmitApi;
}

export interface QueueApi {
  enqueueCommand(input: string, attachments?: Attachment[]): void;
  removeCommand(id: string): void;
  clearQueue(): void;
  sendCommand(id: string): void;
  toggleQueueMode(): void;
}

export function createQueueSlice({ state, getSubmit }: QueueDeps): QueueApi {
  const { commandQueue, commandQueueMode, busy } = state;

  function enqueueCommand(input: string, attachments: Attachment[] = []): void {
    commandQueue.value.push({ id: quid(), input: input.trim(), attachments: [...attachments], ts: Date.now() });
  }
  function removeCommand(id: string): void {
    commandQueue.value = commandQueue.value.filter((item) => item.id !== id);
  }
  function clearQueue(): void {
    commandQueue.value = [];
  }
  function sendCommand(id: string): void {
    const index = commandQueue.value.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = commandQueue.value.splice(index, 1);
    if (busy.value) {
      commandQueue.value.unshift(item);
      return;
    }
    getSubmit().submitText(item.input, item.attachments);
  }
  function toggleQueueMode(): void {
    commandQueueMode.value = commandQueueMode.value === "auto" ? "manual" : "auto";
  }
  watch(
    busy,
    (value) => {
      if (value || commandQueueMode.value !== "auto") return;
      const next = commandQueue.value.shift();
      if (next) getSubmit().submitText(next.input, next.attachments);
    },
    { flush: "sync" },
  );

  return { enqueueCommand, removeCommand, clearQueue, sendCommand, toggleQueueMode };
}
