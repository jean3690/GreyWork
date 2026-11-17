/**
 * LLM 侧的四条聚合命令：模型清单、向量化、单轮补全、语音转写。
 *
 * 都按 OpenAI 兼容端点实现（裸域名补 `/v1`，显式网关路径原样使用）。凭证来自
 * 宿主密钥库或环境变量，请求头支持 `{{ENV}}` 占位符 —— 插件/渲染端拿不到已存 key。
 *
 * 流式聊天与原生 agent 共用请求构建、连接和响应解析。
 */
import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import { secretFor } from "./llm-secrets.js";
import { readChatResponse } from "./llm-response.js";

import type { EventBus } from "./events.js";
import type { WorkspaceAccess } from "./workspace-access.js";

const RESPONSE_READ_HINT = "（检查 Base URL 是否正确、本地服务是否在运行）";

export interface LlmChatMessage {
  role: string;
  content: unknown;
}

/** 裸域名补 /v1；显式路径原样保留（兼容 /api/v1、/compatible-mode/v1 等网关）。 */
export function endpointUrl(baseUrl: string, subPath: string): string {
  const url = new URL(baseUrl.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("Base URL 必须是 HTTP(S) 地址，且不能包含账号密码或片段");
  }
  const base = url.pathname.replace(/\/+$/, "").replace(/\/(chat\/completions|models|embeddings|audio\/transcriptions)$/, "");
  url.pathname = `${base || "/v1"}/${subPath}`;
  return url.toString();
}

export interface ChatRequestOptions {
  model: string;
  reasoningEffort?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  stream?: boolean | null;
  extraBody?: Record<string, unknown> | null;
}

/** 供应商扩展参数不能替换宿主管理的消息、工具或模型。null 可移除不支持的采样字段。 */
export function buildChatBody(options: ChatRequestOptions, messages: unknown[]): Record<string, unknown> {
  const extra = options.extraBody ?? {};
  if (typeof extra !== "object" || Array.isArray(extra)) throw new Error("自定义请求参数必须是 JSON 对象");
  for (const key of ["model", "messages", "tools", "tool_choice", "stream", "functions", "function_call", "n"]) {
    if (Object.hasOwn(extra, key)) throw new Error(`自定义请求参数不能覆盖 ${key}`);
  }
  const body: Record<string, unknown> = { model: options.model, messages, stream: options.stream !== false };
  const effort = reasoningEffort(options.reasoningEffort ?? "");
  if (effort !== null) body.reasoning_effort = effort;
  if (typeof options.temperature === "number") body.temperature = options.temperature;
  if (typeof options.maxTokens === "number") body.max_tokens = options.maxTokens;
  Object.assign(body, extra);
  if (Object.hasOwn(extra, "max_completion_tokens")) delete body.max_tokens;
  for (const key of Object.keys(body)) if (body[key] === null) delete body[key];
  return body;
}

/** 请求头等待超时与响应体空闲超时分开，长时间持续输出不应被 60s 总时长误杀。 */
export async function fetchChatResponse(
  connection: { baseUrl: string; apiKeyEnv?: string | null; headers?: Record<string, string> | null },
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("llm endpoint connection timeout (60s)")), 60_000);
  try {
    return await fetch(endpointUrl(connection.baseUrl, "chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(resolveApiKey(connection.apiKeyEnv, connection.baseUrl), connection.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, timeout.signal]),
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 合成工具回填自检：不访问工作区、不执行模型请求的任何真实工具。 */
export async function probeAgentModel(
  args: ChatRequestOptions & { baseUrl: string; apiKeyEnv?: string | null; headers?: Record<string, string> },
): Promise<{ ok: true; model: string }> {
  if (!args.model.trim()) throw new Error("请先填写模型 ID");
  const signal = AbortSignal.timeout(120_000);
  const messages: Record<string, unknown>[] = [
    { role: "user", content: "Call greywork_probe with value=greywork, then reply with the tool result verbatim." },
  ];
  const tools = [
    {
      type: "function",
      function: {
        name: "greywork_probe",
        description: "A harmless tool calling compatibility test.",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      },
    },
  ];
  const send = async (choice: unknown) => {
    const body = { ...buildChatBody(args, messages), tools, tool_choice: choice };
    const response = await fetchChatResponse(args, body, signal);
    if (!response.ok) throw new Error(`工具调用测试失败：HTTP ${response.status} ${truncate(await response.text(), 200)}`);
    return readChatResponse(response, signal);
  };
  const first = await send("auto");
  const call = first.calls[0];
  if (first.calls.length !== 1 || call?.name !== "greywork_probe")
    throw new Error("模型未返回测试工具调用，请确认模型和网关支持 tool calling");
  let input: { value?: unknown };
  try {
    input = JSON.parse(call.arguments) as { value?: unknown };
  } catch {
    throw new Error("模型返回的工具参数不是合法 JSON");
  }
  if (input?.value !== "greywork") throw new Error("模型未正确生成工具参数");
  const result = `greywork_probe_${randomUUID()}`;
  messages.push({
    role: "assistant",
    content: first.content,
    ...(first.reasoning ? { [first.reasoningField]: first.reasoning } : {}),
    tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }],
  });
  messages.push({ role: "tool", tool_call_id: call.id, content: result });
  const last = await send("none");
  if (last.calls.length || !last.content.includes(result)) throw new Error("模型未正确读取工具回填结果或未遵守 tool_choice=none");
  return { ok: true, model: args.model };
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

/**
 * API Key 解析，优先级：
 * 1. 设置页直接填的 key（按 baseUrl 存在宿主数据目录，0600）；
 * 2. 环境变量（apiKeyEnv）：变量名为空表示匿名（本地服务）；
 * 3. 都没有 → 报错并指出两条补法。
 */
export function resolveApiKey(apiKeyEnv: string | null | undefined, baseUrl?: string | null): string {
  const stored = secretFor(baseUrl);
  if (stored !== null && stored !== "") return stored;
  const name = (apiKeyEnv ?? "").trim();
  if (name === "") return "";
  const value = process.env[name];
  if (!value) {
    throw new Error(`未设置 API Key：在 设置 → Agent → 编辑供应商 里直接填 key，或先 export ${name}=… 再从同一终端启动 GreyWork`);
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
  const apiKey = resolveApiKey(args.apiKeyEnv, baseUrl);
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
  const apiKey = resolveApiKey(args.apiKeyEnv, baseUrl);
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
  const apiKey = resolveApiKey(args.apiKeyEnv, baseUrl);
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

  async start(
    args: ChatRequestOptions & {
      baseUrl: string;
      model: string;
      apiKeyEnv?: string | null;
      messages: LlmChatMessage[];
      reasoningEffort?: string;
      headers?: Record<string, string>;
      temperature?: number | null;
      maxTokens?: number | null;
      clientToken?: string | null;
    },
  ): Promise<number> {
    const baseUrl = args.baseUrl.trim();
    if (baseUrl === "" || args.model.trim() === "") throw new Error("base_url and model are required");
    const body = buildChatBody(
      args,
      args.messages.map((message) => ({ role: message.role, content: message.content })),
    );
    const controller = new AbortController();
    const response = await fetchChatResponse(args, body, controller.signal);
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
    try {
      const outcome = await readChatResponse(response, controller.signal, {
        onText: (delta) => this.emit(token, "llm-delta", { delta }),
        onThinking: (delta) => this.emit(token, "llm-thinking-delta", { delta }),
      });
      if (!outcome.content.trim()) throw new Error("模型没有返回正文");
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
  const apiKey = resolveApiKey(args.apiKeyEnv, args.baseUrl.trim());
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
