/**
 * 发送队列切片（M5）：回复期间下发的消息先入队，回合结束再补发。
 * auto 模式：每回合结束补发队首一条（补发会再次置 busy，天然一轮一条）；
 * flush:"sync" 使补发恰好发生在 busy 归零那一刻（回复刚结束时）。
 *
 * 补发本身不在这里决定「发给谁」：`dispatch` 是应用级注入的派发器（见 lib/queue-bridge，
 * 接的是 dispatchIntent 这个统一分流点）。没有注入时回落 `submitText`（本地 LLM 管线），
 * 于是单测与纯本地场景不依赖视图层 —— 但**注入缺失时 ACP 会话会走错后端**，所以真实
 * 外壳必须挂 queue-bridge。
 *
 * `getSubmit` 经惰性取值（submit 切片不依赖本切片，无环；getter 只是保持
 * 「切片互访只走 api」的一致性）。
 */
import { watch } from "vue";
import { quid } from "./shared";
import type { Attachment, MessageComment } from "../../types";
import type { ChatStoreState } from "./state";
import type { SubmitApi } from "./submit";

export interface QueueDeps {
  state: ChatStoreState;
  getSubmit: () => SubmitApi;
}

/** 应用级派发器：把一条待发指令交给正确后端（由 lib/queue-bridge 注入 dispatchIntent）。 */
export type QueueDispatch = (input: string, attachments: Attachment[], comments: MessageComment[]) => void;

export interface QueueApi {
  enqueueCommand(input: string, attachments?: Attachment[], comments?: readonly MessageComment[]): void;
  removeCommand(id: string): void;
  clearQueue(): void;
  sendCommand(id: string): void;
  toggleQueueMode(): void;
  /** 注入 / 清除派发器；传 null 回落本地 LLM 管线（submitText）。 */
  setDispatch(dispatch: QueueDispatch | null): void;
}

export function createQueueSlice({ state, getSubmit }: QueueDeps): QueueApi {
  const { commandQueue, commandQueueMode, busy } = state;

  let dispatchOverride: QueueDispatch | null = null;
  function setDispatch(dispatch: QueueDispatch | null): void {
    dispatchOverride = dispatch;
  }
  /** 出队一条交给后端：有注入走注入，否则回落本地 LLM 管线。 */
  function dispatchItem(input: string, attachments: Attachment[], comments: MessageComment[]): void {
    if (dispatchOverride) dispatchOverride(input, attachments, comments);
    else getSubmit().submitText(input, attachments, comments);
  }

  function enqueueCommand(input: string, attachments: Attachment[] = [], comments: readonly MessageComment[] = []): void {
    commandQueue.value.push({
      id: quid(),
      input: input.trim(),
      attachments: [...attachments],
      ...(comments.length > 0 ? { comments: [...comments] } : {}),
      ts: Date.now(),
    });
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
    dispatchItem(item.input, item.attachments, item.comments ?? []);
  }
  function toggleQueueMode(): void {
    commandQueueMode.value = commandQueueMode.value === "auto" ? "manual" : "auto";
  }
  watch(
    busy,
    (value) => {
      if (value || commandQueueMode.value !== "auto") return;
      const next = commandQueue.value.shift();
      if (next) dispatchItem(next.input, next.attachments, next.comments ?? []);
    },
    { flush: "sync" },
  );

  return { enqueueCommand, removeCommand, clearQueue, sendCommand, toggleQueueMode, setDispatch };
}
