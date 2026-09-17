/**
 * 真实管线切片：LLM 流式接收 + 段感知的消息写入（正文 / 思考 / 工具时间线）。
 *
 * 宿主（LLM/ACP）的增量统一经此写入消息：chunk 先入缓冲 ~40ms 合并写一次，
 * 段边界在增量到达时就定下来（避免中途插进来的思考 / 工具串位）。dispatchAssistant
 * 是「真实 vs mock」的统一分发点：配置了可用供应商走流式，否则交给 demo 切片。
 *
 * 与 demo 切片的关系：本切片在无供应商时调用 getDemo().runAssistant 兜底，而
 * runAssistant 又要经本切片的 mutators 写消息 —— 环经 index.ts 的 api 持有者
 * 惰性解析（只在实际调用时跨切片取值）。
 *
 * 流式上下文（llmRequestId / activeTurnToken / streamingInto / llmListening /
 * 缓冲）是本切片的闭包私有，不入 state（与 runtime 切片的策略一致）。
 */
import { buildLlmHistory, localReasoningOverride, resolveLocalEffort, selectLlmProvider } from "../chat-llm";
import { isAskSettled } from "../../lib/ask-question";
import { mergeToolActivities } from "../../lib/tool-activity";
import { t, tid, uid, clearSim } from "./shared";
import type { PermissionTrace, ThreadMessage, ToolActivity } from "../../types";
import type { ChatStoreState } from "./state";
import type { SessionApi } from "./session";
import type { DemoApi } from "./demo";

export interface StreamDeps {
  state: ChatStoreState;
  getSession: () => SessionApi;
  getDemo: () => DemoApi;
}

export interface StreamApi {
  dispatchAssistant(message: ThreadMessage, intentText?: string): Promise<void>;
  abortGeneration(): void;
  appendMessageContent(messageId: string, content: string, threadId?: string): void;
  setMessageContent(messageId: string, content: string, threadId?: string): void;
  appendTools(activities: ToolActivity[], messageId: string, threadId?: string): void;
  setPermissionTrace(trace: PermissionTrace, messageId: string, threadId?: string): void;
  appendMessageThinking(messageId: string, delta: string, threadId?: string): void;
  flushPendingContent(): void;
}

export function createStreamSlice({ state, getSession, getDemo }: StreamDeps): StreamApi {
  const session = getSession();
  const { busy, runningSessionId, streamingMessageId, llmActive, sessionStore, settingsStore } = state;
  const llm = state.llm;

  /** 本轮会话流的调用令牌：过滤 `llm://event` 广播里属于别的流（如远程助手回复）的事件。 */
  let activeTurnToken: string | null = null;
  let llmRequestId: number | null = null;
  /** 当前正被流式续写的消息（null = 无活跃流）。 */
  let streamingInto: ThreadMessage | null = null;
  let llmListening = false;

  /** 流式批处理：chunk 先入缓冲，~40ms 合并写入一次，避免每个 chunk 都触发深层响应式。 */
  const appendBuf = new Map<string, { threadId: string; text: string }>();
  let streamBuf = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushPendingContent();
    }, 40);
  }

  /**
   * 打开（或续用）当前活跃的正文段：思考段在前就先封口，工具段在前则另起一段。
   * text 段只记 `content` 的起始偏移，正文本身不存第二份。
   */
  function openTextSegment(message: ThreadMessage): void {
    const segments = (message.segments ??= []);
    const tail = segments.at(-1);
    if (tail?.kind === "text") return;
    if (tail?.kind === "thinking") tail.endedAt = Date.now();
    segments.push({ kind: "text", id: uid(), from: message.content.length, to: null });
    sessionStore.markDirty();
  }

  /** 立即写入缓冲内容（ACP 回合结束 / 思考与工具插入前 / 测试断言前调用）。 */
  function flushPendingContent(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (appendBuf.size) {
      for (const [messageId, entry] of appendBuf) {
        const message = session.ensure(entry.threadId).find((candidate) => candidate.id === messageId);
        if (!message) continue;
        openTextSegment(message);
        message.content += entry.text;
      }
      appendBuf.clear();
      sessionStore.markDirty();
    }
    if (streamBuf) {
      if (streamingInto) {
        openTextSegment(streamingInto);
        streamingInto.content += streamBuf;
      }
      streamBuf = "";
      sessionStore.markDirty();
    }
  }

  function finishStream(): void {
    flushPendingContent();
    busy.value = false;
    runningSessionId.value = null;
    streamingInto = null;
    llmRequestId = null;
    activeTurnToken = null;
    streamingMessageId.value = null;
  }

  async function ensureLlmListener(): Promise<void> {
    if (llmListening) return;
    llmListening = true;
    await llm.onEvent((event) => {
      // `llm://event` 是全局广播：远程助手的自动回复可能与本会话流同时在跑，
      // 令牌不匹配的事件属于别人（缺令牌 = 旧宿主，按旧行为全收）。
      if (event.payload.clientToken && event.payload.clientToken !== activeTurnToken) return;
      if (event.kind === "llm-delta") {
        if (streamingInto) {
          streamBuf += event.payload.delta ?? "";
          scheduleFlush();
        }
      } else if (event.kind === "llm-done") {
        finishStream();
      } else if (event.kind === "llm-error") {
        if (streamingInto) streamBuf += `\n\n${t("chat.llmError", { detail: event.payload.message ?? "unknown" })}`;
        finishStream();
      }
    });
  }

  /** 统一助手分发：配置了可用供应商 → 真实流式；否则 mock 兜底（明示演示管线）。 */
  async function dispatchAssistant(message: ThreadMessage, intentText = ""): Promise<void> {
    const provider = selectLlmProvider(settingsStore.modelProviders, settingsStore.selectedModelProviderId);
    if (!provider || !llm.isAvailable()) {
      llmActive.value = false;
      getDemo().runAssistant(message, intentText);
      return;
    }
    llmActive.value = true;
    message.planPending = false;
    // 真实管线不演造步骤时间线；增量直接写入 content
    message.steps = [];
    sessionStore.markDirty();
    busy.value = true;
    runningSessionId.value = session.activeThreadId.value;
    streamingInto = message;
    streamingMessageId.value = message.id;
    await ensureLlmListener();
    try {
      const history = await buildLlmHistory(session.ensure(session.activeThreadId.value).filter((item) => item.id !== message.id));
      activeTurnToken = tid();
      llmRequestId = await llm.chat({
        baseUrl: provider.baseUrl ?? "",
        model: provider.model,
        apiKeyEnv: provider.apiKeyEnv,
        messages: history,
        reasoningEffort: resolveLocalEffort(localReasoningOverride.value, provider),
        headers: provider.headers,
        clientToken: activeTurnToken,
      });
    } catch (error) {
      message.content = `[LLM 调用失败] ${error instanceof Error ? error.message : String(error)}`;
      sessionStore.markDirty();
      finishStream();
    }
  }

  /** 中止生成：真实流式走宿主 stop；mock 时间线清定时器。 */
  function abortGeneration(): void {
    if (llmRequestId !== null) {
      void llm.stop(llmRequestId);
      return;
    }
    clearSim();
    busy.value = false;
    runningSessionId.value = null;
    streamingMessageId.value = null;
  }

  /**
   * 通过响应式线程列表更新 ACP 支架；threadId 缺省 = 当前激活线程（向后兼容）。
   * 增量先入缓冲（~40ms 合并），由 flushPendingContent 统一写入；
   * 段边界在增量到达时就定下来，否则中途插进来的思考 / 工具会串位。
   */
  function appendMessageContent(messageId: string, content: string, threadId = session.activeThreadId.value): void {
    const entry = appendBuf.get(messageId);
    if (entry) {
      entry.text += content;
    } else {
      appendBuf.set(messageId, { threadId, text: content });
      const message = session.ensure(threadId).find((candidate) => candidate.id === messageId);
      if (message) openTextSegment(message);
    }
    scheduleFlush();
  }

  function setMessageContent(messageId: string, content: string, threadId = session.activeThreadId.value): void {
    // 丢弃待 flush 的增量，避免覆盖回退后再被缓冲追加。
    appendBuf.delete(messageId);
    const message = session.ensure(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return;
    message.content = content;
    // 正文整体替换（错误文案 / 无输出兜底）：偏移全失效，思考与工具段保留，正文归一段挂到末尾。
    const kept = (message.segments ?? []).filter((segment) => segment.kind !== "text");
    message.segments = content ? [...kept, { kind: "text", id: uid(), from: 0, to: null }] : kept;
    sessionStore.markDirty();
  }

  /**
   * 把工具活动增量并入指定消息的 tools 时间线，并登记到当前工具段。
   * 已在某段里的 toolCallId（后续 tool_call_update）不重复登记，也不另起新段。
   */
  function appendTools(activities: ToolActivity[], messageId: string, threadId = session.activeThreadId.value): void {
    // 缓冲里的正文先落地，否则这批工具会插到还没写出的正文之前，段序错位。
    flushPendingContent();
    const message = session.ensure(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return;
    message.tools = mergeToolActivities(message.tools, activities);
    // 提问型工具（AskUserQuestion）：把载荷提到消息上供选择菜单渲染。
    // 已作答的不覆盖 —— 迟到的 tool_call_update 不能把用户的答案冲掉。
    if (!isAskSettled(message.ask)) {
      const ask = activities.find((activity) => activity.ask)?.ask;
      if (ask) {
        message.ask = ask;
        sessionStore.markDirty();
      }
    }
    const segments = (message.segments ??= []);
    for (const activity of activities) {
      if (segments.some((segment) => segment.kind === "tools" && segment.toolCallIds.includes(activity.toolCallId))) continue;
      let tail = segments.at(-1);
      if (tail?.kind !== "tools") {
        if (tail?.kind === "thinking") tail.endedAt = Date.now();
        else if (tail?.kind === "text") tail.to = message.content.length;
        tail = { kind: "tools", id: uid(), toolCallIds: [] };
        segments.push(tail);
      }
      tail.toolCallIds.push(activity.toolCallId);
      sessionStore.markDirty();
    }
  }

  /**
   * 追加思考链增量（ACP AgentThoughtChunk / mock 揭示共用入口）。
   * 连续的思考并进同一段；一旦被正文或工具打断，下一波思考另起一段。
   */
  function appendMessageThinking(messageId: string, delta: string, threadId = session.activeThreadId.value): void {
    flushPendingContent();
    const message = session.ensure(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return;
    const segments = (message.segments ??= []);
    const tail = segments.at(-1);
    const now = Date.now();
    if (tail?.kind === "thinking") {
      tail.text += delta;
      tail.endedAt = now;
      sessionStore.markDirty();
      return;
    }
    if (tail?.kind === "text") tail.to = message.content.length;
    segments.push({ kind: "thinking", id: uid(), text: delta, startedAt: now, endedAt: now });
    sessionStore.markDirty();
  }

  /**
   * 追加一次权限裁决留痕，把卡片从「待确认」转成消息流里的只读记录。
   *
   * 按 toolCallId 去重而不是「只留最新」：一个回合可能连续问多次（每条 bash 一次），
   * 全都要留；而同一 toolCallId 的重复写入（超时兜底与迟到应答抢跑）只算一次。
   */
  function setPermissionTrace(trace: PermissionTrace, messageId: string, threadId = session.activeThreadId.value): void {
    const message = session.ensure(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return;
    const traces = (message.permissions ??= []);
    if (traces.some((existing) => existing.toolCallId === trace.toolCallId)) return;
    traces.push(trace);
    sessionStore.markDirty();
  }

  return {
    dispatchAssistant,
    abortGeneration,
    appendMessageContent,
    setMessageContent,
    appendTools,
    setPermissionTrace,
    appendMessageThinking,
    flushPendingContent,
  };
}
