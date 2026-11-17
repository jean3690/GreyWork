import { randomUUID } from "node:crypto";

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatOutcome {
  content: string;
  reasoning: string;
  reasoningField: "reasoning_content" | "reasoning";
  calls: ModelToolCall[];
}

/** 同时支持整包 JSON 和 SSE；只有完整消费响应后才把工具调用交给执行层。 */
export async function readChatResponse(
  response: Response,
  signal: AbortSignal,
  options: { onText?: (text: string) => void; onThinking?: (text: string) => void; idleTimeoutMs?: number } = {},
): Promise<ChatOutcome> {
  const outcome: ChatOutcome = { content: "", reasoning: "", reasoningField: "reasoning_content", calls: [] };
  const calls = new Map<number, ModelToolCall>();
  let finishReason: string | null = null;
  let seenChoice = false;
  let textBatch = "";
  let thinkingBatch = "";
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (textBatch) options.onText?.(textBatch);
    if (thinkingBatch) options.onThinking?.(thinkingBatch);
    textBatch = thinkingBatch = "";
  };
  const schedule = () => {
    flushTimer ??= setTimeout(() => {
      flushTimer = undefined;
      flush();
    }, 30);
  };
  const consume = (value: Record<string, unknown>, streaming: boolean) => {
    if (value.error) {
      const error = value.error as { message?: unknown };
      throw new Error(typeof error.message === "string" ? error.message : "模型端点返回错误");
    }
    const choices = value.choices as { delta?: Record<string, unknown>; message?: Record<string, unknown>; finish_reason?: string }[];
    const choice = choices?.[0];
    if (!choice) return; // stream_options.include_usage 的尾帧没有 choices。
    seenChoice = true;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const message = (streaming ? choice.delta : choice.message) ?? {};
    const content =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part: { text?: string }) => part?.text ?? "").join("")
          : "";
    const field = typeof message.reasoning_content === "string" ? "reasoning_content" : "reasoning";
    const reasoning = message[field];
    if (typeof reasoning === "string" && reasoning) {
      if (textBatch) flush();
      outcome.reasoningField = field;
      outcome.reasoning += reasoning;
      thinkingBatch += reasoning;
    }
    if (content) {
      if (thinkingBatch) flush();
      outcome.content += content;
      textBatch += content;
    }
    const chunks = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const [position, raw] of chunks.entries()) {
      if (!raw || typeof raw !== "object") continue;
      const chunk = raw as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
      const index = chunk.index ?? position;
      if (!Number.isInteger(index) || index < 0) continue;
      const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof chunk.id === "string" && chunk.id) call.id = chunk.id;
      if (typeof chunk.function?.name === "string") call.name += chunk.function.name;
      if (typeof chunk.function?.arguments === "string") call.arguments += chunk.function.arguments;
      calls.set(index, call);
    }
    schedule();
  };
  const reader = response.body?.getReader();
  if (!reader) throw new Error("响应没有可读流");
  const decoder = new TextDecoder();
  let buffer = "";
  let doneMarker = false;
  const streaming = (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
  const consumeLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      doneMarker = true;
      return;
    }
    if (!payload) return;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      throw new Error("模型流返回了不合法的 JSON");
    }
    consume(value, true);
  };
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!doneMarker) {
      signal.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("llm endpoint idle timeout"));
          void reader.cancel().catch(() => undefined);
        }, options.idleTimeoutMs ?? 60_000);
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (timedOut) throw new Error("llm endpoint idle timeout");
      signal.throwIfAborted();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (streaming) {
        let newline = buffer.indexOf("\n");
        while (newline >= 0 && !doneMarker) {
          consumeLine(buffer.slice(0, newline).replace(/\r$/, ""));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      }
      if (chunk.done) {
        if (streaming) consumeLine(buffer.replace(/\r$/, ""));
        else {
          let value: Record<string, unknown>;
          try {
            value = JSON.parse(buffer) as Record<string, unknown>;
          } catch {
            throw new Error("响应不是合法 JSON");
          }
          consume(value, false);
        }
        break;
      }
    }
    if (!seenChoice) throw new Error("端点未返回 Chat Completions 响应（请检查接口协议和地址）");
    if (streaming && !doneMarker && !finishReason) throw new Error("模型流提前结束，未执行不完整的工具调用");
    if (finishReason === "length") throw new Error("模型输出达到 token 上限；请提高最大输出 token，未执行可能被截断的工具调用");
    if (finishReason === "content_filter") throw new Error("模型输出被服务端内容过滤器阻止");
    outcome.calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({ ...call, id: call.id || `call_${randomUUID()}` }));
    return outcome;
  } finally {
    signal.removeEventListener("abort", onAbort);
    clearTimeout(flushTimer);
    flush();
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
