/**
 * 本机模型 agent 回合：让 OpenAI 兼容端点上的模型能用工具，而不必装外部 ACP agent。
 * 移植 crates/greywork-host/src/services/llm/agent/（mod + runner + tools）。
 *
 * 与纯聊天（llm.ts::LlmStreamHost）的关系：大脑是用户自己的模型端点，工具面由宿主
 * 提供**并在自己的授权面内执行** —— 只读三件套（读文件 / 列目录 / 最近提交），
 * 全部复用 WorkspaceAccess 与 gitLog，不存在第二套 allow-list。因此无需交互式
 * 权限确认，循环可以在宿主侧自主推进。
 *
 * 两个必须显式处理的协议细节（与 Rust 同款）：
 * - arguments 可能不是合法 JSON：解析失败就回空对象让 executeTool 报错，模型重发；
 * - 触顶后要收尾回合：追加一次 tool_choice 为 none 的收尾请求，而不是直接掐断。
 */
import { authHeaders, endpointUrl, resolveApiKey, truncate, type LlmChatMessage } from "./llm.js";
import { gitLog } from "./git.js";
import type { EventBus } from "./events.js";
import type { WorkspaceAccess } from "./workspace-access.js";

/** 连接挂着但长时间无字节，按错误终止（与纯聊天路径同源的空闲超时）。 */
const IDLE_TIMEOUT_MS = 60_000;

/** 工具回合的默认上限（12 轮覆盖典型的「摸现状 → 定位 → 交叉验证」长路径）。 */
export const DEFAULT_MAX_ROUNDS = 12;

/** 回合硬上限：调用方可传更大的值，但不能没有。 */
export const HARD_MAX_ROUNDS = 32;

/** 单次工具输出送进模型上下文的字符上限（12k 字符 ≈ 3-4k token）。 */
const MAX_TOOL_OUTPUT_CHARS = 12_000;
/** git_log 默认返回条数。 */
const DEFAULT_GIT_LOG_LIMIT = 20;
/** 目录列举的条目数上限。 */
const MAX_DIR_ENTRIES = 200;

export interface AgentStartArgs {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string | null;
  messages: LlmChatMessage[];
  reasoningEffort?: string | null;
  headers?: Record<string, string> | null;
  temperature?: number | null;
  maxTokens?: number | null;
  maxRounds?: number | null;
  clientToken?: string | null;
}

interface AgentTurn {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  messages: Record<string, unknown>[];
  reasoningEffort: string;
  headers: Record<string, string>;
  temperature: number | null;
  maxTokens: number | null;
  maxRounds: number;
  clientToken: string;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ToolOutput {
  content: string;
  error: string | null;
  summary: string;
  path: string | null;
}

/* ===== 工具的 openai function schema ===== */

function toolSchemas(): Record<string, unknown>[] {
  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "读取工作区内一个文本文件的全文。用于查看源码、配置、文档。路径相对于工作区根，也可给绝对路径。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径，相对工作区根或绝对路径。必须是文本文件。" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "列出工作区内一个目录的直接子项（文件与子目录）。用于先摸清结构再决定读哪个文件。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "目录路径，省略时列工作区根目录。" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_log",
        description: "读取工作区的最近提交历史（哈希、作者、时间、标题）。用于了解近期改了什么。",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "integer", description: "返回条数，默认 20。" },
          },
          required: [],
        },
      },
    },
  ];
}

/** 按字符截断并**显式标注**省略了多少：静默截断会让模型基于残缺内容自信出错。 */
function clampOutput(value: string): string {
  const chars = [...value];
  if (chars.length <= MAX_TOOL_OUTPUT_CHARS) return value;
  return chars.slice(0, MAX_TOOL_OUTPUT_CHARS).join("") + "\n\n[已截断：共 " + chars.length + " 字符，只保留前 " + MAX_TOOL_OUTPUT_CHARS + " 字符。需要更多内容请用更小的范围重读]";
}

function failed(error: string, path: string | null): ToolOutput {
  return {
    content: "工具执行失败：" + error,
    error,
    summary: "执行失败",
    path,
  };
}

function argStr(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error("参数 " + key + " 必须是字符串");
  if (value.trim() === "") throw new Error("参数 " + key + " 是空字符串，请给出实际路径");
  return value;
}

/** 把模型给的路径锚成绝对路径：相对的挂在工作区根下（.. 交给 resolveExisting 拦）。 */
function anchorToRoot(access: WorkspaceAccess, raw: string): string {
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return raw;
  return access.root + "/" + raw.replace(/^\/+/, "");
}

function optionalLimit(input: Record<string, unknown>): number | null {
  const value = input.limit;
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("参数 limit 必须是正整数");
  }
  return value;
}

/** 执行一次工具调用。未知工具名返回错误而不是崩掉回合：模型经常编造工具名。 */
async function executeTool(access: WorkspaceAccess, name: string, input: Record<string, unknown>): Promise<ToolOutput> {
  try {
    if (name === "read_file") {
      const path = anchorToRoot(access, argStr(input, "path"));
      const text = access.readTextFile(path);
      return {
        content: clampOutput(text),
        error: null,
        summary: "读取 " + path + "（" + [...text].length + " 字符）",
        path,
      };
    }
    if (name === "list_dir") {
      const path = input.path === undefined || input.path === null ? access.root : anchorToRoot(access, argStr(input, "path"));
      const entries = access.listDir(path);
      const total = entries.length;
      const shown = Math.min(total, MAX_DIR_ENTRIES);
      let text = "";
      for (const entry of entries.slice(0, shown)) {
        // 目录带尾斜杠：模型据此区分「这是个能进去的目录」还是「同名文件」。
        text += entry.kind === "directory" ? entry.name + "/\n" : entry.name + "\n";
      }
      if (total > shown) {
        text += "\n[已截断：共 " + total + " 项，只列前 " + shown + " 项。缩小 path 再看剩余部分]";
      }
      return { content: text, error: null, summary: "列出 " + path + "（" + total + " 项）", path };
    }
    if (name === "git_log") {
      const limit = optionalLimit(input) ?? DEFAULT_GIT_LOG_LIMIT;
      const root = access.root;
      const commits = await gitLog(access, root, limit, null);
      if (commits.length === 0) {
        return {
          content: "这个工作区没有提交历史（可能不是 git 仓库，或仓库还没有任何提交）。",
          error: null,
          summary: "读取提交历史（空）",
          path: root,
        };
      }
      let text = "";
      for (const commit of commits) {
        // 一行一提交：哈希 / 相对时间 / 作者 / 主题。refs 带上是因为「这条提交在哪个分支上」常常就是线索。
        const refs = commit.refs === "" ? "" : " (" + commit.refs + ")";
        text += commit.shortHash + " " + commit.timestamp + refs + " " + commit.author + " — " + commit.subject + "\n";
      }
      return { content: text, error: null, summary: "读取最近 " + limit + " 条提交（" + commits.length + " 条）", path: root };
    }
    if (name === "") {
      return failed("这次调用没有工具名（name 为空），请重新发起并指明要用哪个工具", null);
    }
    return failed("没有名为 " + name + " 的工具。可用工具：read_file（读文本文件）、list_dir（列目录）、git_log（最近提交）", null);
  } catch (error) {
    return failed((error as Error).message, null);
  }
}

/* ===== SSE 增量与工具调用分片 ===== */

interface SseDelta {
  content: string | null;
  reasoning: string | null;
  toolCallChunks: { index: number; id: string | null; name: string | null; arguments: string | null }[];
}

function parseSseDelta(data: string): SseDelta | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  const choices = value.choices as Record<string, unknown>[] | undefined;
  const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
  if (!delta) return null;
  const pick = (key: string): string | null => {
    const text = delta[key];
    return typeof text === "string" && text !== "" ? text : null;
  };
  const rawCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  const toolCallChunks = rawCalls
    .map((chunk) => {
      const record = chunk as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      if (typeof record.index !== "number") return null;
      const fn = record.function ?? {};
      return {
        index: record.index,
        id: typeof record.id === "string" && record.id !== "" ? record.id : null,
        name: typeof fn.name === "string" && fn.name !== "" ? fn.name : null,
        arguments: typeof fn.arguments === "string" && fn.arguments !== "" ? fn.arguments : null,
      };
    })
    .filter((chunk): chunk is { index: number; id: string | null; name: string | null; arguments: string | null } => chunk !== null);
  return {
    content: pick("content"),
    reasoning: pick("reasoning_content") ?? pick("reasoning"),
    toolCallChunks,
  };
}

/** 按 index 归位拼接一个回合里的工具调用分片；缺 id / 缺 name 合成兜底。 */
class ToolCallAccumulator {
  private readonly calls = new Map<number, { id: string | null; name: string | null; arguments: string }>();
  private synthSeq = 0;

  push(chunks: { index: number; id: string | null; name: string | null; arguments: string | null }[]): void {
    for (const chunk of chunks) {
      const call = this.calls.get(chunk.index) ?? { id: null, name: null, arguments: "" };
      this.calls.set(chunk.index, call);
      if (chunk.id !== null) call.id = chunk.id;
      if (chunk.name !== null) call.name = chunk.name;
      if (chunk.arguments !== null) call.arguments += chunk.arguments;
    }
  }

  take(): ToolCall[] {
    const indexes = [...this.calls.keys()].sort((a, b) => a - b);
    const out: ToolCall[] = [];
    for (const index of indexes) {
      const call = this.calls.get(index)!;
      this.calls.delete(index);
      const id = call.id ?? "call_synth_" + index + "_" + (++this.synthSeq);
      out.push({ id, name: call.name ?? "", arguments: call.arguments });
    }
    return out;
  }
}

function contentFromCompletion(body: Record<string, unknown>): string {
  const choices = body.choices as Record<string, unknown>[] | undefined;
  const content = (choices?.[0]?.message as Record<string, unknown> | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part as { text?: unknown }).text)
      .filter((text): text is string => typeof text === "string")
      .join("");
  }
  return "";
}

function toolCallsFromCompletion(body: Record<string, unknown>): ToolCall[] {
  const choices = body.choices as Record<string, unknown>[] | undefined;
  const items = (choices?.[0]?.message as Record<string, unknown> | undefined)?.tool_calls;
  if (!Array.isArray(items)) return [];
  const accumulator = new ToolCallAccumulator();
  accumulator.push(
    items.map((item, index) => {
      const record = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const fn = record.function ?? {};
      return {
        index,
        id: typeof record.id === "string" && record.id !== "" ? record.id : null,
        name: typeof fn.name === "string" && fn.name !== "" ? fn.name : null,
        arguments: typeof fn.arguments === "string" && fn.arguments !== "" ? fn.arguments : null,
      };
    }),
  );
  return accumulator.take();
}

/* ===== 宿主状态与回合循环 ===== */

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

/** 本机 agent 回合的宿主状态：请求 id 分配 + 可中止的任务句柄（与纯聊天流独立）。 */
export class LlmAgentHost {
  private nextId = 0;
  private readonly tasks = new Map<number, AbortController>();

  constructor(
    private readonly bus: EventBus,
    private readonly access: WorkspaceAccess,
  ) {}

  private emit(token: string, kind: string, payload: Record<string, unknown>): void {
    if (token !== "") payload.clientToken = token;
    this.bus.broadcast("llm://event", { kind, payload });
  }

  /** 发起一个 agent 回合；返回请求 id（用于中止）。参数错误早返回，不 spawn 再报。 */
  start(args: AgentStartArgs): number {
    const baseUrl = args.baseUrl.trim();
    const model = args.model.trim();
    if (baseUrl === "" || model === "") throw new Error("base_url and model are required");
    if (!Array.isArray(args.messages) || args.messages.length === 0) {
      throw new Error("messages 不能为空");
    }
    const requestId = this.nextId++;
    const turn: AgentTurn = {
      baseUrl,
      model,
      apiKeyEnv: args.apiKeyEnv ?? "",
      messages: args.messages.map((message) => ({ role: message.role, content: message.content })),
      reasoningEffort: args.reasoningEffort ?? "",
      headers: args.headers ?? {},
      temperature: args.temperature ?? null,
      maxTokens: args.maxTokens ?? null,
      maxRounds: Math.min(Math.max(args.maxRounds ?? DEFAULT_MAX_ROUNDS, 1), HARD_MAX_ROUNDS),
      clientToken: args.clientToken ?? "",
    };
    const controller = new AbortController();
    this.tasks.set(requestId, controller);
    void this.run(turn, controller).finally(() => {
      // 回合结束时自己摘掉句柄：长跑会话不会攒下大量已完成句柄。
      this.tasks.delete(requestId);
    });
    return requestId;
  }

  /** 中止进行中的 agent 回合并回收句柄。 */
  stop(requestId: number): void {
    const controller = this.tasks.get(requestId);
    if (!controller) throw new Error("unknown llm agent request " + requestId);
    this.tasks.delete(requestId);
    controller.abort();
  }

  /** 跑完一个 agent 回合。所有出口都保证发出 llm-done 或 llm-error。 */
  private async run(turn: AgentTurn, controller: AbortController): Promise<void> {
    try {
      await this.drive(turn, controller);
    } catch (error) {
      if (controller.signal.aborted) return;
      this.emit(turn.clientToken, "llm-error", { message: (error as Error).message });
      return;
    }
    if (!controller.signal.aborted) this.emit(turn.clientToken, "llm-done", {});
  }

  private async drive(turn: AgentTurn, controller: AbortController): Promise<void> {
    const schemas = toolSchemas();
    const history: Record<string, unknown>[] = [...turn.messages];
    const accumulator = new ToolCallAccumulator();
    const apiKey = resolveApiKey(turn.apiKeyEnv);

    // round < maxRounds 是工具回合；最后一轮是收尾回合（tool_choice: none）。
    for (let round = 0; round <= turn.maxRounds; round += 1) {
      const body: Record<string, unknown> = {
        model: turn.model,
        stream: true,
        messages: history,
      };
      const effort = reasoningEffort(turn.reasoningEffort);
      if (effort !== null) body.reasoning_effort = effort;
      if (turn.temperature !== null) body.temperature = turn.temperature;
      if (turn.maxTokens !== null) body.max_tokens = turn.maxTokens;
      body.tools = schemas;
      body.tool_choice = round < turn.maxRounds ? "auto" : "none";

      const response = await fetch(endpointUrl(turn.baseUrl, "chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(apiKey, turn.headers) },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).catch((error: Error) => {
        throw new Error("llm request failed: " + error.message);
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error("llm endpoint returned " + response.status + ": " + truncate(text, 200) + "（检查 Base URL 是否正确、本地服务是否在运行）");
      }
      const outcome = await this.drainRound(response, turn, controller, accumulator);

      // 没有工具调用 = 模型给出了最终答复，收尾。
      if (outcome.calls.length === 0) {
        if (round === turn.maxRounds && outcome.content.trim() === "") {
          throw new Error("工具回合用了满 " + turn.maxRounds + " 轮仍未给出结论；可提高回合上限或缩小问题范围");
        }
        return;
      }
      if (round === turn.maxRounds) {
        // 收尾回合不该再拿到调用：拿到了说明端点不认 tool_choice=none，再执行只会死循环。
        throw new Error("端点未遵守 tool_choice=none，第 " + turn.maxRounds + " 轮后仍在请求工具；已中止该回合");
      }

      // assistant 消息：正文用空串而非 null —— 部分端点对 content:null 直接 400。
      history.push({
        role: "assistant",
        content: outcome.content,
        tool_calls: outcome.calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });

      for (const call of outcome.calls) {
        const input = parseArguments(call.arguments);
        this.emit(turn.clientToken, "llm-tool-call", { id: call.id, name: call.name, input, round });
        const output = await executeTool(this.access, call.name, input);
        this.emit(turn.clientToken, "llm-tool-result", {
          id: call.id,
          ok: output.error === null,
          error: output.error,
          summary: output.summary,
          path: output.path,
          // 只送预览：完整输出可能上万字符，前端时间线不需要，而事件是全局广播的。
          preview: truncate(output.content, 400),
        });
        history.push({
          role: "tool",
          tool_call_id: call.id,
          content: output.content,
        });
      }
    }
  }

  /** 消费一个回合的流，边下发正文 / 思考边把工具调用分片喂给累积器。 */
  private async drainRound(
    response: Response,
    turn: AgentTurn,
    controller: AbortController,
    accumulator: ToolCallAccumulator,
  ): Promise<{ content: string; calls: ToolCall[] }> {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // 非流式：一次性拿全文与全部调用（端点忽略 stream 时）。
      const text = await response.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error("响应不是合法 JSON: " + truncate(text, 200));
      }
      const content = contentFromCompletion(body);
      if (content !== "") this.emit(turn.clientToken, "llm-delta", { delta: content });
      return { content, calls: toolCallsFromCompletion(body) };
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("响应没有可读流");
    const decoder = new TextDecoder();
    let content = "";
    let contentBatch = "";
    let thinkingBatch = "";
    let flushTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let idleMessage: string | null = null;
    const armIdle = () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      // 空闲超时：拿不到新字节就主动断流（以错误收场，循环会把错误上报）。
      idleTimer = setTimeout(() => {
        idleMessage = "llm endpoint idle timeout (" + IDLE_TIMEOUT_MS / 1000 + "s)";
        controller.abort();
      }, IDLE_TIMEOUT_MS);
    };
    const flush = () => {
      if (contentBatch !== "") {
        this.emit(turn.clientToken, "llm-delta", { delta: contentBatch });
        contentBatch = "";
      }
      if (thinkingBatch !== "") {
        this.emit(turn.clientToken, "llm-thinking-delta", { delta: thinkingBatch });
        thinkingBatch = "";
      }
    };
    const schedule = () => {
      if (flushTimer !== null) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, 30);
    };
    armIdle();

    let buffer = "";
    let streamError: Error | null = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        armIdle();
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
            if (idleTimer !== null) clearTimeout(idleTimer);
            if (flushTimer !== null) clearTimeout(flushTimer);
            flush();
            return { content, calls: accumulator.take() };
          }
          let parsed: { error?: { message?: unknown } } & Record<string, unknown>;
          try {
            parsed = JSON.parse(payload) as { error?: { message?: unknown } } & Record<string, unknown>;
          } catch {
            continue;
          }
          if (typeof parsed.error?.message === "string") throw new Error(parsed.error.message);
          const delta = parseSseDelta(payload);
          if (delta === null) continue;
          if (delta.content !== null) {
            content += delta.content;
            contentBatch += delta.content;
            schedule();
          }
          if (delta.reasoning !== null) {
            thinkingBatch += delta.reasoning;
            schedule();
          }
          if (delta.toolCallChunks.length > 0) accumulator.push(delta.toolCallChunks);
        }
      }
    } catch (error) {
      streamError = error as Error;
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer);
      if (flushTimer !== null) clearTimeout(flushTimer);
      // 终止之前必须把缓冲发出去，否则本轮最后一段正文会丢。
      flush();
    }
    if (idleMessage !== null) throw new Error(idleMessage);
    if (streamError !== null) throw streamError;
    return { content, calls: accumulator.take() };
  }
}

/** 解析模型的 arguments。非法 JSON 不是致命错误：回空对象让 executeTool 报「缺少参数」。 */
function parseArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
