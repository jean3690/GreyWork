/**
 * chat store 装配入口（文件夹 facade）。
 *
 * 六片切片共享 `createChatState()` 造的同一份状态注册表；切片间的循环函数依赖
 * （stream→demo 的 runAssistant、demo→stream 的段写入 mutators）经 `api` 持有者
 * + 惰性 getter 解决——任何切片的函数都要到实际调用时才跨切片取值，因此装配顺序
 * 无关紧要。
 *
 * 公开 store API（returns 的键）与原 `stores/chat.ts` 完全一致；
 * 模块级导出 buildSteps / buildThinking 原样再导出。
 */
import { defineStore } from "pinia";
import { clearSim } from "./shared";
import type { SessionApi } from "./session";
import type { StreamApi } from "./stream";
import type { DemoApi } from "./demo";
import type { SubmitApi } from "./submit";
import type { QueueApi } from "./queue";
import { createSessionSlice } from "./session";
import { createStreamSlice } from "./stream";
import { createDemoSlice } from "./demo";
import { createSubmitSlice } from "./submit";
import { createQueueSlice } from "./queue";
import { createChatState } from "./state";

export { buildSteps, buildThinking } from "./shared";

export const useChatStore = defineStore("chat", () => {
  const state = createChatState();

  /** 惰性 api 绑定：切片互相只经 getter 访问。 */
  const api: {
    session: SessionApi | null;
    stream: StreamApi | null;
    demo: DemoApi | null;
    submit: SubmitApi | null;
    queue: QueueApi | null;
  } = { session: null, stream: null, demo: null, submit: null, queue: null };
  const getSession = (): SessionApi => api.session as SessionApi;
  const getStream = (): StreamApi => api.stream as StreamApi;
  const getDemo = (): DemoApi => api.demo as DemoApi;
  const getSubmit = (): SubmitApi => api.submit as SubmitApi;

  api.session = createSessionSlice({ state });
  api.stream = createStreamSlice({ state, getSession, getDemo });
  api.demo = createDemoSlice({ state, getSession, getStream });
  api.submit = createSubmitSlice({ state, getSession, getStream });
  api.queue = createQueueSlice({ state, getSubmit });
  const session = api.session as SessionApi;
  const stream = api.stream as StreamApi;
  const submit = api.submit as SubmitApi;
  const queue = api.queue as QueueApi;

  return {
    activeThreadId: session.activeThreadId,
    threads: session.threads,
    busy: state.busy,
    runningSessionId: state.runningSessionId,
    speedBoost: state.speedBoost,
    commandQueue: state.commandQueue,
    commandQueueMode: state.commandQueueMode,
    enqueueCommand: queue.enqueueCommand,
    removeCommand: queue.removeCommand,
    clearQueue: queue.clearQueue,
    sendCommand: queue.sendCommand,
    toggleQueueMode: queue.toggleQueueMode,
    clearSim,
    ensure: session.ensure,
    submitText: submit.submitText,
    confirmPlan: submit.confirmPlan,
    cancelPlan: submit.cancelPlan,
    markAskAnswered: submit.markAskAnswered,
    startAcpTurn: submit.startAcpTurn,
    appendMessageContent: stream.appendMessageContent,
    setMessageContent: stream.setMessageContent,
    appendTools: stream.appendTools,
    appendMessageThinking: stream.appendMessageThinking,
    flushPendingContent: stream.flushPendingContent,
    streamingMessageId: state.streamingMessageId,
    llmReady: state.llmReady,
    llmActive: state.llmActive,
    abortGeneration: stream.abortGeneration,
  };
});
