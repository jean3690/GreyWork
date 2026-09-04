/**
 * Agent 工具活动（ToolActivity）的纯函数工具：
 * ACP session-update 工具部分解析、聚合行构建、生命周期、展示标签。
 *
 * 概念对齐 ACP 协议（v2 draft）的 tool_call / tool_call_result 内容，
 * 以及 OpenWork 的「按工具调用聚合」模式（同文件重复读折叠为一行 + ×N）。
 * 纯数据函数，便于单测；不依赖 Vue / Pinia。
 */
import type { ToolActivity, ToolActivityKind, ToolActivityStatus, ToolDetail } from "../types";
import { isRecord } from "./guards";

/* ===== ACP session-update 负载解析 ===== */

/**
 * 从 ACP session/update 原始负载中提取工具活动增量。
 *
 * 支持两种 update 形态：
 *  - `update.sessionUpdate === "agent_message"`：内容数组含 tool_call / tool_call_result 部分
 *  - `update.sessionUpdate === "agent_message_chunk"`：若是 agent_message 的增量块，可能带 tool_call 片段
 * 内容部分可能落在 `update.content`（对象）或其 `.parts` / `.content`（数组）。
 */
export interface AcpToolPartLike {
  type?: string;
  /** 部分 id（tool 调用 / 结果 id；结果用 toolUseID / tool_call_id）。 */
  id?: string;
  tool_call_id?: string;
  toolUseID?: string;
  tool_call?: {
    id?: string;
    name?: string;
    kind?: string;
    input?: Record<string, unknown>;
    status?: string;
  };
  tool_call_result?: {
    toolUseID?: string;
    is_error?: boolean;
    content?: unknown;
  };
  status?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  thought?: string;
}

/** 工具调用类型 → display 分组（同族工具归一行展示 verb）。 */
export const TOOL_FAMILY_LABEL: Record<string, string> = {
  read: "read",
  edit: "edit",
  delete: "delete",
  move: "move",
  search: "grep / search",
  execute: "run",
  think: "think",
  fetch: "fetch",
  other: "call",
};

/** 由 tool_call.name / kind / ACP kind 推断 ToolActivityKind。 */
export function resolveToolKind(raw: string | undefined, name?: string): ToolActivityKind {
  if (!raw) {
    if (name === "bash" || name === "zsh" || name === "shell" || name === "run_command") return "execute";
    if (name === "Read") return "read";
    if (name === "Edit" || name === "MultiEdit" || name === "Write") return "edit";
    if (name === "Glob" || name === "Grep" || name === "Search") return "search";
    if (name === "WebFetch" || name === "WebSearch") return "fetch";
    if (name === "Task") return "other";
    if (name === "TodoWrite" || name === "todowrite") return "other";
    return "other";
  }
  const k = raw.toLowerCase();
  if (k.includes("read")) return "read";
  if (k.includes("edit") || k.includes("write") || k.includes("patch")) return "edit";
  if (k.includes("delete")) return "delete";
  if (k.includes("move") || k.includes("rename")) return "move";
  if (k.includes("search") || k.includes("grep") || k.includes("glob")) return "search";
  if (k.includes("run") || k.includes("exec") || k.includes("shell") || k.includes("bash")) return "execute";
  if (k.includes("think")) return "think";
  if (k.includes("fetch") || k.includes("web")) return "fetch";
  return "other";
}

/**
 * 拆解 MCP 工具名。ACP 的 tool_call 没有独立工具名字段：agent 把 MCP 工具名
 * 原样塞进 title，形如 `mcp__<server>__<tool>`，kind 一律落 `other`
 * （见 claude-code-acp `src/tools.ts` 默认分支 `title: name, kind: "other"`）。
 * server 为 undefined 表示不是外部 MCP 调用：`mcp__acp__Read` 这类是客户端自带的
 * 文件桥，不该在 UI 上标成 MCP。
 */
export function parseMcpToolName(raw: string | undefined): { server?: string; tool: string } | null {
  if (!raw) return null;
  const matched = /^mcp__(.+?)__(.+)$/.exec(raw);
  if (!matched) return null;
  return { server: matched[1] === "acp" ? undefined : matched[1], tool: matched[2] };
}

/** 从 tool_call 的 input 中提取文件路径字段（优先 file_path / path / filepath）。 */
export function pathFromToolInput(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  const candidate = input.file_path ?? input.path ?? input.filePath ?? input.filepath ?? input.filename;
  if (typeof candidate === "string" && candidate) return candidate;
  return undefined;
}

/** 从 tool_call 的 input 中提取命令字段（execute / bash）。 */
export function commandFromToolInput(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  const candidate = input.command ?? input.cmd ?? input.shell_command;
  if (typeof candidate === "string" && candidate) return candidate;
  return undefined;
}

/** 解析状态：未明确 → pending；in_progress/active/running → in_progress。 */
export function resolveToolStatus(raw: string | undefined): ToolActivityStatus {
  const s = (raw ?? "").toLowerCase();
  if (s === "completed" || s === "done" || s === "success") return "completed";
  if (s === "failed" || s === "error") return "failed";
  if (s === "in_progress" || s === "running" || s === "active" || s === "pending") return "in_progress";
  return "pending";
}

/** 把一条 ACP 内容部分规范化成一条 ToolActivity（无 id 时生成占位）。 */
export function toToolActivity(part: AcpToolPartLike, now = Date.now(), seq = 0): ToolActivity | null {
  const tool = part.tool_call;
  let kind: ToolActivityKind;
  let id: string;
  let command: string | undefined;
  let path: string | undefined;
  let description: string | undefined;
  let status: ToolActivityStatus;
  let error: string | undefined;
  let rawName: string | undefined;

  if (tool) {
    id = tool.id ?? part.id ?? `tc-${now}-${seq}`;
    kind = resolveToolKind(tool.kind, tool.name);
    status = resolveToolStatus(tool.status);
    command = commandFromToolInput(tool.input);
    path = pathFromToolInput(tool.input);
    rawName = tool.name;
    description = (typeof tool.input?.description === "string" && tool.input.description) || tool.name;
    if (tool.status === "failed") error = String(tool.input?.error ?? "tool failed");
  } else if (part.tool_call_result) {
    id = part.tool_call_result.toolUseID ?? part.tool_call_id ?? part.id ?? `tcr-${now}-${seq}`;
    kind = "other";
    status = part.tool_call_result.is_error ? "failed" : "completed";
    path = pathFromToolInput(part.input);
    command = commandFromToolInput(part.input);
    description = part.tool_call_result.is_error ? "tool result error" : undefined;
    if (part.tool_call_result.is_error)
      error = typeof part.tool_call_result.content === "string" ? part.tool_call_result.content : "tool result error";
  } else if (part.input) {
    // 兼容扁平 { name, input, status }
    id = part.id ?? `tc-${now}-${seq}`;
    kind = resolveToolKind(undefined, part.name);
    status = resolveToolStatus(part.status);
    command = commandFromToolInput(part.input);
    path = pathFromToolInput(part.input);
    rawName = part.name;
    description = typeof part.input.description === "string" ? part.input.description : part.name;
  } else if (part.thought !== undefined || part.type === "thinking" || part.type === "reasoning") {
    // 思考 / 推理块：有独立 id 时记录，否则丢弃（避免一坨仅 presentation 的记录）
    id = part.id ?? `think-${now}-${seq}`;
    kind = "think";
    status = "completed";
    description = "thinking";
  } else {
    return null;
  }

  const mcp = parseMcpToolName(rawName);
  // 原始名当描述没有可读性（`mcp__deepwiki__ask_question`）→ 收敛为纯工具名，服务器名单列
  if (mcp && description === rawName) description = mcp.tool;

  return {
    toolCallId: id,
    kind,
    status,
    startedAt: now,
    finishedAt: status === "completed" || status === "failed" ? now : null,
    command,
    path,
    description,
    name: mcp?.tool ?? rawName,
    mcpServer: mcp?.server,
    error,
  };
}

/**
 * 从 ACP session/update 负载提取一批工具活动增量。
 * 原地返回数组；多数 session-update 只带文本 chunk，返回空。
 * 支持两类真实负载形态：
 *  - ACP v2 顶层 tool_call / tool_call_update / tool_call_content_chunk（真实后端）
 *  - agent_message 内嵌 content parts（部分 Agent 实现的 Anthropic 风格）
 */
export function parseToolActivityPayload(payload: unknown, now = Date.now()): ToolActivity[] {
  if (!payload || typeof payload !== "object") return [];
  const update = (payload as { update?: Record<string, unknown> }).update;
  if (!update) return [];

  // 1) ACP v2 顶层工具调用形态
  const toolCallParsed = parseToolCallUpdate(payload, now);
  if (toolCallParsed) return [toolCallParsed];

  const contentType = update.content;
  if (!contentType) return [];
  // content 可能是对象（含 text）或数组（parts）
  const parts: AcpToolPartLike[] = Array.isArray(contentType) ? (contentType as AcpToolPartLike[]) : [contentType as AcpToolPartLike];
  const out: ToolActivity[] = [];
  let seq = 0;
  for (const part of parts) {
    const activity = toToolActivity(part, now, seq);
    if (activity) out.push(activity);
    seq += 1;
  }
  return out;
}

/* ===== ACP v2 顶层工具调用（tool_call / tool_call_update) 解析 ===== */

/**
 * tool_call_update 中的 location / diff 里提取受影响文件路径。
 * 形态：locations = [{ path, line }]；ACP diff 内容块自带 path，另兼容 changes = [{ operation, path }]。
 */
function pathFromToolLocations(update: Record<string, unknown>): string | undefined {
  if (Array.isArray(update.locations)) {
    const first: unknown = update.locations[0];
    if (isRecord(first) && typeof first.path === "string" && first.path) return first.path;
  }
  if (Array.isArray(update.content)) {
    for (const block of update.content) {
      if (!isRecord(block)) continue;
      if (block.type !== "diff") continue;
      if (typeof block.path === "string" && block.path) return block.path;
      if (Array.isArray(block.changes)) {
        for (const change of block.changes) {
          if (isRecord(change) && typeof change.path === "string" && change.path) return change.path;
        }
      }
    }
  }
  return undefined;
}

/** 细节字段留存上限：会话要落盘（localStorage + 会话文件），不能把整个大文件写进存档。 */
const MAX_DETAIL_CHARS = 8000;

/** 从 ContentBlock 取可展示文本（text / resource 内嵌文本；图片音频只给类型占位）。 */
function textFromContentBlock(block: unknown): string | undefined {
  if (!isRecord(block)) return undefined;
  if (typeof block.text === "string") return block.text;
  if (isRecord(block.resource) && typeof block.resource.text === "string") return block.resource.text;
  if (block.type === "image" || block.type === "audio") {
    return typeof block.mimeType === "string" ? `[${block.type} ${block.mimeType}]` : `[${block.type}]`;
  }
  return undefined;
}

/**
 * 归一化工具调用细节：ACP 的 content 内容块（diff / 文本 / 终端）+ rawInput 入参 + rawOutput 结果。
 * ACP 语义是「整体替换」，所以每次 update 重算细节，由 mergeToolActivities 决定是否覆盖。
 */
function detailFromToolUpdate(update: Record<string, unknown>, path?: string, command?: string): ToolDetail | undefined {
  const detail: ToolDetail = {};
  const texts: string[] = [];
  if (Array.isArray(update.content)) {
    for (const block of update.content) {
      if (!isRecord(block)) continue;
      if (block.type === "diff" && typeof block.newText === "string") {
        detail.diff = {
          path: typeof block.path === "string" ? block.path : (path ?? ""),
          oldText: typeof block.oldText === "string" ? block.oldText : null,
          newText: block.newText,
        };
        continue;
      }
      if (block.type === "terminal" && typeof block.terminalId === "string") {
        detail.terminalId = block.terminalId;
        continue;
      }
      const text = textFromContentBlock(block.content ?? block);
      if (text) texts.push(text);
    }
  }
  if (texts.length > 0) detail.text = texts.join("\n");
  // 结果没走 content 内容块时（多数 MCP 工具）退回 rawOutput：
  // MCP 的标准返回是 { content: [{type:"text", …}] }，取出文本再退化到 JSON。
  if (!detail.text) {
    if (typeof update.rawOutput === "string") detail.text = update.rawOutput;
    else if (isRecord(update.rawOutput)) {
      const blocks = Array.isArray(update.rawOutput.content) ? update.rawOutput.content : [update.rawOutput.content];
      const joined = blocks
        .map((block) => textFromContentBlock(block))
        .filter((text): text is string => text !== undefined)
        .join("\n");
      detail.text = joined || JSON.stringify(update.rawOutput, null, 2);
    }
  }
  if (isRecord(update.rawInput)) {
    // 行首已经显示过的入参不重复进 args，否则 write 的整份文件内容会在 diff 和入参里各存一遍
    const shown = ["description", "name"];
    if (detail.diff) shown.push("content", "new_string", "old_string");
    if (command) shown.push("command", "cmd");
    if (path) shown.push("file_path", "path", "filePath");
    const args = Object.entries(update.rawInput).filter(([key]) => !shown.includes(key));
    if (args.length > 0) detail.args = JSON.stringify(Object.fromEntries(args), null, 2);
  }
  if (detail.text && detail.text.length > MAX_DETAIL_CHARS) {
    detail.text = detail.text.slice(0, MAX_DETAIL_CHARS);
    detail.clipped = true;
  }
  if (detail.args && detail.args.length > MAX_DETAIL_CHARS) {
    detail.args = detail.args.slice(0, MAX_DETAIL_CHARS);
    detail.clipped = true;
  }
  if (detail.diff) {
    if (detail.diff.newText.length > MAX_DETAIL_CHARS) {
      detail.diff.newText = detail.diff.newText.slice(0, MAX_DETAIL_CHARS);
      detail.clipped = true;
    }
    if (detail.diff.oldText && detail.diff.oldText.length > MAX_DETAIL_CHARS) {
      detail.diff.oldText = detail.diff.oldText.slice(0, MAX_DETAIL_CHARS);
      detail.clipped = true;
    }
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
}

/** 从 tool_call 的 rawInput 中提取命令（execute）。 */
function commandFromRawInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const candidate = record.command ?? record.cmd ?? record.arguments ?? record.args ?? record.shell_command;
  if (typeof candidate === "string" && candidate) return candidate;
  if (Array.isArray(candidate) && candidate.length) return candidate.map(String).join(" ");
  return undefined;
}

/** 归一化 ACP ToolKind → ToolActivityKind；未知按其他。 */
function kindFromToolKind(raw: unknown): ToolActivityKind {
  const k = String(raw ?? "").toLowerCase();
  if (["read"].includes(k)) return "read";
  if (["edit", "write", "patch"].includes(k)) return "edit";
  if (["delete", "remove"].includes(k)) return "delete";
  if (["move", "rename"].includes(k)) return "move";
  if (["search", "grep", "glob", "web_search"].includes(k)) return "search";
  if (["execute", "bash", "run", "shell"].includes(k)) return "execute";
  if (["think", "reasoning"].includes(k)) return "think";
  if (["fetch", "web_fetch", "fetch_url"].includes(k)) return "fetch";
  if (String(raw ?? "").startsWith("_")) return "other";
  return "other";
}

/** 归一化 ACP ToolCallStatus → ToolActivityStatus（cancelled → interrupted）。 */
function statusFromToolStatus(raw: unknown): ToolActivityStatus {
  const s = String(raw ?? "pending").toLowerCase();
  if (["completed", "done", "success"].includes(s)) return "completed";
  if (["failed", "error"].includes(s)) return "failed";
  if (["cancelled", "canceled", "interrupted", "interrupt"].includes(s)) return "interrupted";
  if (["in_progress", "running", "active"].includes(s)) return "in_progress";
  return "pending";
}

/**
 * 解析单个 ACP v2 顶层工具调用更新（sessionUpdate ∈ tool_call / tool_call_update）。
 * 这是真实后端喂入时间线的数据源：同一 toolCallId 的 pending → in_progress → completed
 * 由 mergeToolActivities 原地续写，无需在此展开生命周期。
 */
export function parseToolCallUpdate(payload: unknown, now = Date.now()): ToolActivity | null {
  if (!payload || typeof payload !== "object") return null;
  const update = (payload as { update?: Record<string, unknown> }).update;
  if (!update) return null;
  const kind = String(update.sessionUpdate ?? "");
  if (!["tool_call", "tool_call_update", "tool_call_content_chunk"].includes(kind)) return null;

  const toolCallId = String(update.toolCallId ?? `tc-${now}`);
  const activityKind = kindFromToolKind(update.kind);
  const status = statusFromToolStatus(update.status);
  const path = pathFromToolLocations(update);
  const command = commandFromRawInput(update.rawInput) ?? (activityKind === "execute" ? commandFromRawInput(update.input) : undefined);
  const rawInput = isRecord(update.rawInput) ? update.rawInput : undefined;
  const title = typeof update.title === "string" && update.title ? update.title : undefined;
  // MCP 调用的身份只藏在 title（或部分 agent 的 rawInput.name）里
  const mcpFromTitle = parseMcpToolName(title);
  const mcp = mcpFromTitle ?? parseMcpToolName(typeof rawInput?.name === "string" ? rawInput.name : undefined);
  const description = mcpFromTitle
    ? mcpFromTitle.tool
    : (title ?? (rawInput && typeof rawInput.description === "string" ? rawInput.description : undefined));
  const detail = detailFromToolUpdate(update, path, command);

  return {
    toolCallId,
    kind: activityKind,
    status,
    startedAt: now,
    finishedAt: status === "completed" || status === "failed" || status === "interrupted" ? now : null,
    command,
    path,
    description,
    name: mcp?.tool,
    mcpServer: mcp?.server,
    detail,
  };
}

/* ===== 聚合行 ===== */

/** 展示用：工具家族（聚合 & 折叠去重依据）。 */
export function toolFamily(activity: ToolActivity): ToolActivityKind {
  return activity.kind;
}

/** 是否仍在飞行（未 settle）。 */
export function isInFlight(activity: ToolActivity): boolean {
  return activity.status === "pending" || activity.status === "in_progress";
}

/** 某某动作在运行时的进行时动词。 */
export function presentVerb(kind: ToolActivityKind): string {
  switch (kind) {
    case "read":
      return "Reading";
    case "edit":
      return "Editing";
    case "delete":
      return "Deleting";
    case "move":
      return "Moving";
    case "search":
      return "Searching";
    case "execute":
      return "Running";
    case "think":
      return "Thinking";
    case "fetch":
      return "Fetching";
    default:
      return "Working on";
  }
}

/** 已 settle 动作的过去式动词（聚合头摘要用）。 */
export function pastCountVerb(kind: ToolActivityKind): string {
  switch (kind) {
    case "read":
      return "Read";
    case "edit":
      return "Edited";
    case "delete":
      return "Deleted";
    case "move":
      return "Moved";
    case "search":
      return "Searched";
    case "execute":
      return "Ran";
    case "fetch":
      return "Fetched";
    case "think":
      return "Thought";
    default:
      return "Called";
  }
}

export interface AggregateRow {
  /** 该行最后一次调用（驱动状态 / 标签 / 耗时）。 */
  activity: ToolActivity;
  /** 该行代表的同族调用次数。 */
  repeat: number;
}

/**
 * 把一条消息内的 ToolActivity 列表聚合为展示行：
 * 连续且同族、同文件的 completed 调用折叠为一行 + 计数；
 * 中间穿插 think/failed/in_progress 则不折叠，保真时序。
 */
export function buildActivityRows(activities: ToolActivity[]): AggregateRow[] {
  const rows: AggregateRow[] = [];
  for (const activity of activities) {
    const previous = rows.at(-1);
    const samePath =
      previous && previous.activity.path !== undefined && activity.path !== undefined && previous.activity.path === activity.path;
    const mergeable =
      samePath !== undefined &&
      previous !== undefined &&
      toolFamily(previous.activity) === toolFamily(activity) &&
      previous.activity.status === "completed" &&
      activity.status === "completed" &&
      !(activity.kind === "think") &&
      samePath;
    if (mergeable) {
      previous.activity = activity;
      previous.repeat += 1;
    } else {
      rows.push({ activity, repeat: 1 });
    }
  }
  return rows;
}

/** 整体聚合生命周期：任一 in_progress → running；否则全部 failed? failed : (全 reflected ? done : waiting)。 */
export function aggregateLifecycle(activities: ToolActivity[]): "running" | "failed" | "done" | "waiting" {
  if (activities.some((a) => isInFlight(a))) return "running";
  if (activities.some((a) => a.status === "pending")) return "waiting";
  if (activities.some((a) => a.status === "failed")) return "failed";
  if (activities.some((a) => a.status === "interrupted")) return "failed";
  return "done";
}

/** 运行中摘要文案（「Reading reports/data.xlsx」或命令）。 */
export function runningNowLabel(activities: ToolActivity[]): string | null {
  const current = activities.find((a) => isInFlight(a));
  if (!current) return null;
  const verb = presentVerb(current.kind);
  if (current.mcpServer) return `Calling ${current.mcpServer} · ${current.name ?? current.description ?? "tool"}`;
  return current.kind === "execute" && current.command
    ? `Running ${current.command}`
    : current.path
      ? `${verb} ${current.path}`
      : current.description
        ? `${verb} ${current.description}`
        : verb;
}

/** 聚合头摘要文案（done/failed 时过去式计数；running 时实时文案）。 */
export function aggregateSummary(activities: ToolActivity[], lifecycle: string = aggregateLifecycle(activities)): string {
  if (lifecycle === "running") return runningNowLabel(activities) ?? "Working…";
  if (activities.length === 0) return "No activity";
  // 按家族计数：Read 3 files · Ran 2 commands
  const byFamily = new Map<ToolActivityKind, number>();
  for (const a of activities) {
    const key = a.kind === "execute" ? "execute" : a.kind;
    byFamily.set(key, (byFamily.get(key) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [kind, count] of byFamily) {
    parts.push(`${pastCountVerb(kind)} ${count} ${kind === "execute" ? "command" + (count > 1 ? "s" : "") : count > 1 ? "items" : "item"}`);
  }
  return parts.length ? parts.slice(0, 3).join(" · ") : "Completed";
}

/** 一条活动 → 单行标签（展开列表内用）。 */
export function activityRowLabel(activity: ToolActivity): string {
  if (activity.kind === "execute" && activity.command) return activity.command;
  if (activity.path) return activity.path;
  return activity.description ?? presentVerb(activity.kind);
}

/** 活动展示动词（单行：Read / Editing / Ran …）。 */
export function activityRowVerb(activity: ToolActivity): string {
  return isInFlight(activity) ? presentVerb(activity.kind) : pastCountVerb(activity.kind);
}

/** 已耗时或持续时间（ms → `1.2s` / `320ms`）。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/** 从 startedAt/finishedAt 求已完成调用的耗时（ms）。 */
export function durationOf(activity: ToolActivity, now = Date.now()): number | null {
  if (activity.finishedAt != null) return Math.max(0, activity.finishedAt - activity.startedAt);
  if (isInFlight(activity)) return Math.max(0, now - activity.startedAt);
  return null;
}

/**
 * 把一批工具活动增量合并进已有时间线（就地变更数组，保持响应式）。
 * 生命周期续写规则：以 toolCallId 定位，同一活动再次出现（如 pending → in_progress →
 * completed）时原地升级状态 / finishedAt，而不是新增一条；新 id 追加到末尾。
 */
export function mergeToolActivities(existing: ToolActivity[] | undefined, incoming: ToolActivity[]): ToolActivity[] {
  if (!existing) existing = [];
  for (const activity of incoming) {
    const index = existing.findIndex((a) => a.toolCallId === activity.toolCallId);
    if (index >= 0) {
      const prev = existing[index];
      // 状态只进不退；finishedAt 一旦有值不覆盖回 null
      if (activity.status !== "pending") prev.status = activity.status;
      if (activity.finishedAt != null) prev.finishedAt = activity.finishedAt;
      if (activity.path) prev.path = activity.path;
      if (activity.command) prev.command = activity.command;
      if (activity.error) prev.error = activity.error;
      if (activity.name) prev.name = activity.name;
      if (activity.mcpServer) prev.mcpServer = activity.mcpServer;
      // 细节按字段合并：ACP 的 content 是整体替换，但省略 content 的 update 不该把已收到的内容清空
      if (activity.detail) prev.detail = { ...prev.detail, ...activity.detail };
    } else {
      existing.push(activity);
    }
  }
  return existing;
}
