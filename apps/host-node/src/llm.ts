/**
 * LLM 侧的四条聚合命令：模型清单、向量化、单轮补全、语音转写。
 *
 * 都按「OpenAI 兼容端点」实现（`/v1` 缺省补、已带版本段则直拼），凭证只认**环境变量名**，
 * 请求头支持 `{{ENV}}` 占位符由宿主解析 —— 插件/渲染端永远拿不到 key。
 *
 * 流式聊天（`llm_chat_start` / `llm_agent_start`）需要事件总线与可中止句柄，放在下一批。
 */
import { statSync } from "node:fs";
import { basename } from "node:path";

import type { EventBus } from "./events.js";
import type { WorkspaceAccess } from "./workspace-access.js";

const RESPONSE_READ_HINT = "（检查 Base URL 是否正确、本地服务是否在运行）";

export interface LlmChatMessage {
  role: string;
  content: unknown;
}

/** 拼接 openai 兼容端点：baseUrl 已带 `/v1` 这类版本段就直拼，否则补 `/v1`。 */
export function endpointUrl(baseUrl: string, subPath: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const last = trimmed.split("/").pop() ?? "";
  const hasVersion = last.length >= 2 && last.startsWith("v") && /^\d+$/.test(last.slice(1));
  return hasVersion ? `${trimmed}/${subPath}` : `${trimmed}/v1/${subPath}`;
}

/** 解析请求头里的 `{{ENV}}` 占位符；变量缺失就报错，绝不把模板原样发出去。 */
function resolvePlaceholders(value: string): string {
  return value.replace(/\{\{([^}]*)\}\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    const resolved = process.env[name];
    if (!resolved) {
      throw new Error(
        `未设置环境变量 ${name}：请求头占位符 {{{${name}}}} 无法解析，请先 export 后从同一终端启动 GreyWork（或到设置页修改该请求头）`,
      );
    }
    return resolved;
  });
}

/** API Key：变量名为空表示匿名（本地服务）；声明了却未设置 → 指路用户去补。 */
export function resolveApiKey(apiKeyEnv: string | null | undefined): string {
  const name = (apiKeyEnv ?? "").trim();
  if (name === "") return "";
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `未设置 API Key：先在本机终端执行 export ${name}=…，再从同一终端启动 GreyWork（设置页 → Agent → 模型供应商可查看/修改变量名）`,
    );
  }
  return value;
}

function authHeaders(apiKey: string, headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (apiKey !== "") out.authorization = `Bearer ${apiKey}`;
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key.toLowerCase()] = resolvePlaceholders(value);
  }
  return out;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

export { authHeaders, truncate };

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text === "" ? null : JSON.parse(text);
  } catch {
    throw new Error(`响应不是合法 JSON: ${truncate(text, 200)}`);
  }
}

/** `GET /models`：兼容 OpenAI `data[].id` 与 Ollama `models[].name`。 */
export async function listModels(args: {
  baseUrl: string;
  apiKeyEnv?: string | null;
  headers?: Record<string, string>;
}): Promise<string[]> {
  const baseUrl = args.baseUrl.trim();
  if (baseUrl === "") throw new Error("base_url is required");
  const apiKey = resolveApiKey(args.apiKeyEnv);
  const response = await fetch(endpointUrl(baseUrl, "models"), {
    headers: authHeaders(apiKey, args.headers),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`llm endpoint returned ${response.status}: ${truncate(body, 200)}${RESPONSE_READ_HINT}`);
  }
  const body = (await readJson(response)) as { data?: { id?: unknown }[]; models?: { name?: unknown }[] };
  const ids: string[] = [];
  for (const item of body?.data ?? []) if (typeof item.id === "string") ids.push(item.id);
  for (const item of body?.models ?? []) if (typeof item.name === "string") ids.push(item.name);
  return [...new Set(ids)].sort();
}

export interface EmbedResult {
  embeddings: number[][];
  dim: number;
  model: string;
}

export async function embed(args: {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string | null;
  headers?: Record<string, string>;
  input: string[];
}): Promise<EmbedResult> {
  const baseUrl = args.baseUrl.trim();
  const model = args.model.trim();
  if (baseUrl === "" || model === "") throw new Error("base_url and model are required");
  if (args.input.length === 0) return { embeddings: [], dim: 0, model };
  const apiKey = resolveApiKey(args.apiKeyEnv);
  const response = await fetch(endpointUrl(baseUrl, "embeddings"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(apiKey, args.headers) },
    body: JSON.stringify({ model, input: args.input }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `llm embeddings returned ${response.status}: ${truncate(body, 200)}（确认该模型是 embedding 模型、且服务支持 /v1/embeddings）`,
    );
  }
  const body = (await readJson(response)) as { data?: { embedding?: unknown }[] };
  const embeddings = (body?.data ?? []).map((item) => (Array.isArray(item.embedding) ? item.embedding.map((value) => Number(value)) : []));
  return { embeddings, dim: embeddings[0]?.length ?? 0, model };
}

/** 推理档位 → openai `reasoning_effort`；auto/未知不传，max 收敛为 high。 */
function reasoningEffort(value: string): string | null {
  switch (value.trim().toLowerCase()) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return "high";
    default:
      return null;
  }
}

/** 聚合式单轮补全：SSE 与整包 JSON 两种响应都收；只回正文（思考链不进产物）。 */
export async function chatComplete(args: {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string | null;
  messages: LlmChatMessage[];
  reasoningEffort?: string;
  headers?: Record<string, string>;
}): Promise<string> {
  const baseUrl = args.baseUrl.trim();
  if (baseUrl === "") throw new Error("base_url is required");
  const apiKey = resolveApiKey(args.apiKeyEnv);
  const body: Record<string, unknown> = {
    model: args.model,
    stream: true,
    messages: args.messages.map((message) => ({ role: message.role, content: message.content })),
  };
  const effort = reasoningEffort(args.reasoningEffort ?? "");
  if (effort !== null) body.reasoning_effort = effort;

  const response = await fetch(endpointUrl(baseUrl, "chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(apiKey, args.headers) },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`llm endpoint returned ${response.status}: ${truncate(text, 200)}${RESPONSE_READ_HINT}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const payload = (await readJson(response)) as { choices?: { message?: { content?: unknown } }[] };
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text === "string") return text;
    throw new Error("empty completion");
  }
  return collectSseText(response);
}

/** 读 SSE：`data: {…}` 累加 delta.content，`[DONE]` 结束；连接直接关闭视为完成。 */
async function collectSseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("响应没有可读流");
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return text;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: { delta?: { content?: unknown } }[];
          error?: { message?: unknown };
        };
        if (typeof parsed.error?.message === "string") throw new Error(parsed.error.message);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === "string") text += delta;
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
  }
  return text;
}

/**
 * 流式聊天宿主：请求 id 分配 + 可中止句柄。
 *
 * 事件走 `llm://event`（全局广播，消费方凭 `clientToken` 过滤自己那一笔）：
 * `llm-delta` / `llm-thinking-delta` / `llm-done` / `llm-error`。正文与思考各自独立合批，
 * 合批窗口 30ms —— 逐 chunk 广播会在长回复里把事件数放大一个数量级。
 */
export class LlmStreamHost {
  private nextId = 0;
  private readonly streams = new Map<number, AbortController>();

  constructor(private readonly bus: EventBus) {}

  async start(args: {
    baseUrl: string;
    model: string;
    apiKeyEnv?: string | null;
    messages: LlmChatMessage[];
    reasoningEffort?: string;
    headers?: Record<string, string>;
    temperature?: number | null;
    maxTokens?: number | null;
    clientToken?: string | null;
  }): Promise<number> {
    const baseUrl = args.baseUrl.trim();
    if (baseUrl === "" || args.model.trim() === "") throw new Error("base_url and model are required");
    const apiKey = resolveApiKey(args.apiKeyEnv);
    const body: Record<string, unknown> = {
      model: args.model,
      stream: true,
      messages: args.messages.map((message) => ({ role: message.role, content: message.content })),
    };
    const effort = reasoningEffort(args.reasoningEffort ?? "");
    if (effort !== null) body.reasoning_effort = effort;
    if (typeof args.temperature === "number") body.temperature = args.temperature;
    if (typeof args.maxTokens === "number") body.max_tokens = args.maxTokens;

    const controller = new AbortController();
    const response = await fetch(endpointUrl(baseUrl, "chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(apiKey, args.headers) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`llm endpoint returned ${response.status}: ${truncate(text, 200)}${RESPONSE_READ_HINT}`);
    }
    const requestId = this.nextId++;
    this.streams.set(requestId, controller);
    const token = (args.clientToken ?? "").trim();
    void this.consume(requestId, response, token, controller);
    return requestId;
  }

  /** 中止：与 Rust 一致，只杀任务、不再补发事件。 */
  stop(requestId: number): boolean {
    const controller = this.streams.get(requestId);
    if (!controller) return false;
    controller.abort();
    this.streams.delete(requestId);
    return true;
  }

  private emit(token: string, kind: string, payload: Record<string, unknown>): void {
    if (token !== "") payload.clientToken = token;
    this.bus.broadcast("llm://event", { kind, payload });
  }

  private async consume(requestId: number, response: Response, token: string, controller: AbortController): Promise<void> {
    const flush = (kind: string, text: string) => {
      if (text !== "") this.emit(token, kind, { delta: text });
    };
    let content = "";
    let thinking = "";
    const finish = () => {
      flush("llm-delta", content);
      flush("llm-thinking-delta", thinking);
      content = "";
      thinking = "";
    };

    try {
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        // 服务端忽略 stream：整包 JSON 也要按增量语义发一次。
        const payload = (await readJson(response)) as { choices?: { message?: { content?: unknown } }[] };
        const text = payload?.choices?.[0]?.message?.content;
        if (typeof text === "string" && text !== "") {
          content = text;
          finish();
        }
        this.emit(token, "llm-done", {});
        return;
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("响应没有可读流");
      const decoder = new TextDecoder();
      let buffer = "";
      let timer: NodeJS.Timeout | null = null;
      const schedule = () => {
        if (timer !== null) return;
        timer = setTimeout(() => {
          timer = null;
          finish();
        }, 30);
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            if (timer !== null) clearTimeout(timer);
            finish();
            this.emit(token, "llm-done", {});
            return;
          }
          try {
            const parsed = JSON.parse(payload) as {
              choices?: { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }[];
              error?: { message?: unknown };
            };
            if (typeof parsed.error?.message === "string") throw new Error(parsed.error.message);
            const delta = parsed.choices?.[0]?.delta;
            if (typeof delta?.content === "string") {
              content += delta.content;
              schedule();
            }
            const reason =
              typeof delta?.reasoning_content === "string"
                ? delta.reasoning_content
                : typeof delta?.reasoning === "string"
                  ? delta.reasoning
                  : "";
            if (reason !== "") {
              thinking += reason;
              schedule();
            }
          } catch (error) {
            if (error instanceof SyntaxError) continue;
            throw error;
          }
        }
      }
      if (timer !== null) clearTimeout(timer);
      finish();
      this.emit(token, "llm-done", {});
    } catch (error) {
      if (controller.signal.aborted) return;
      this.emit(token, "llm-error", { message: (error as Error).message });
    } finally {
      this.streams.delete(requestId);
    }
  }
}

const TRANSCRIBE_MAX_BYTES = 20 * 1024 * 1024;

/** 语音转写：音频从授权路径读（附件根始终授权），20MB 上限。 */
export async function transcribe(
  access: WorkspaceAccess,
  args: {
    baseUrl: string;
    model: string;
    apiKeyEnv?: string | null;
    headers?: Record<string, string>;
    path: string;
    language?: string | null;
  },
): Promise<{ text: string }> {
  const baseUrl = args.baseUrl.trim();
  if (baseUrl === "") throw new Error("base_url is required");
  const file = access.resolveExisting(args.path);
  const size = statSync(file).size;
  if (size === 0) throw new Error("音频文件为空");
  if (size > TRANSCRIBE_MAX_BYTES) {
    throw new Error(`音频超过上限 ${TRANSCRIBE_MAX_BYTES / 1024 / 1024} MB，无法转写`);
  }
  const apiKey = resolveApiKey(args.apiKeyEnv);
  const bytes = access.readBinary(file);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/octet-stream" }), basename(file));
  form.append("response_format", "json");
  if (args.model.trim() !== "") form.append("model", args.model.trim());
  if ((args.language ?? "").trim() !== "") form.append("language", (args.language ?? "").trim());

  const response = await fetch(endpointUrl(baseUrl, "audio/transcriptions"), {
    method: "POST",
    headers: authHeaders(apiKey, args.headers),
    body: form,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`llm transcribe returned ${response.status}: ${truncate(body, 200)}`);
  }
  const payload = (await readJson(response)) as { text?: unknown };
  if (typeof payload?.text !== "string") throw new Error("转写响应缺少 text");
  return { text: payload.text };
}
