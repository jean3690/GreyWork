import type { CoworkDirective, CoworkTaskStatus } from "./types";

/** 协作指令的载体：agent 输出里的 ```cowork 代码块，内容为一条指令或指令数组。 */
const DIRECTIVE_FENCE = /```cowork\s*([\s\S]*?)```/gi;

const TASK_STATUSES: Record<string, CoworkTaskStatus> = {
  pending: "pending",
  in_progress: "in_progress",
  done: "done",
  failed: "failed",
};

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function toDirective(raw: unknown): CoworkDirective | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const op = text(record.op);

  if (op === "message") {
    const to = text(record.to);
    const body = text(record.body);
    if (!to || !body) return null;
    const summary = text(record.summary);
    return summary ? { op, to, body, summary } : { op, to, body };
  }

  if (op === "task") {
    const subject = text(record.subject);
    if (!subject) return null;
    const blockedBy = Array.isArray(record.blockedBy) ? record.blockedBy.map(text).filter((id) => id.length > 0) : [];
    const directive: CoworkDirective = { op, subject };
    const detail = text(record.detail);
    if (detail) directive.detail = detail;
    const owner = text(record.owner);
    if (owner) directive.owner = owner;
    if (blockedBy.length > 0) directive.blockedBy = blockedBy;
    return directive;
  }

  if (op === "task_update") {
    const taskId = text(record.taskId);
    if (!taskId) return null;
    const status = TASK_STATUSES[text(record.status)];
    const result = text(record.result);
    // 既不改状态也不写结论的更新是空操作，丢弃以免产生无意义的事件。
    if (!status && !result) return null;
    const directive: CoworkDirective = { op, taskId };
    if (status) directive.status = status;
    if (result) directive.result = result;
    return directive;
  }

  return null;
}

/**
 * 从 agent 输出中提取协作指令。
 *
 * 容错策略与既有 `parsePlan` 一致：解析失败、结构不合法的条目直接跳过，
 * 绝不因为模型多写一句解释文字就丢掉整批指令。只认带 `cowork` 标签的围栏，
 * 不扫裸 JSON——否则 agent 写的示例代码会被当成真实指令执行。
 */
export function parseDirectives(output: string): CoworkDirective[] {
  const directives: CoworkDirective[] = [];
  for (const match of output.matchAll(DIRECTIVE_FENCE)) {
    const body = (match[1] ?? "").trim();
    if (!body) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const directive = toDirective(item);
      if (directive) directives.push(directive);
    }
  }
  return directives;
}
