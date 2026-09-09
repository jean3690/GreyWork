import type { AgentRole } from "./types";

/** 子任务状态机：pending → running → done | failed。 */
export type SubtaskStatus = "pending" | "running" | "done" | "failed";

export interface Subtask {
  id: string;
  role: AgentRole;
  prompt: string;
  status: SubtaskStatus;
  error?: string;
}

/** 一次编排运行：planning（planner 出计划）→ running（子任务执行）→ done | failed。 */
export type RunStatus = "planning" | "running" | "done" | "failed";

export interface PlannerRun {
  id: string;
  goal: string;
  status: RunStatus;
  subtasks: Subtask[];
  createdAt: number;
  finishedAt?: number;
}

let runSeq = 0;
let subSeq = 0;

/** 全局唯一子任务 id：parsePlan 与 createSubtask 共享，避免追加子任务 id 撞车。 */
function nextSubId(): string {
  subSeq += 1;
  return `sub-${subSeq}`;
}

export function createPlannerRun(goal: string): PlannerRun {
  runSeq += 1;
  return { id: `run-${runSeq}`, goal, status: "planning", subtasks: [], createdAt: Date.now() };
}

/** 追加一个子任务（replan 用）；id 全局递增保证唯一。 */
export function createSubtask(role: AgentRole, prompt: string): Subtask {
  return { id: nextSubId(), role, prompt, status: "pending" };
}

/** planner 的 prompt：要求只输出结构化 JSON 计划，不夹带解释文字。 */
export function buildPlanPrompt(goal: string): string {
  return [
    "你是任务编排器。请把以下目标拆解为可并行执行的子任务。",
    `目标：${goal}`,
    "只输出 JSON，不要任何解释文字。JSON 格式：",
    '[{"role":"planner|researcher|builder|reviewer","prompt":"自包含的子任务指令"}]',
    "要求：2-5 个子任务；每条 prompt 自包含、可直接交给另一个 agent 独立执行；不要包含本指令。",
  ].join("\n");
}

const VALID_ROLES = new Set<string>(["planner", "researcher", "builder", "reviewer"]);

/** 从 agent 响应文本中容错提取子任务数组；无法解析时返回 null。
 * 提取策略：取首个 `[` 到末个 `]` 之间的 JSON，逐项校验 role/prompt。 */
export function parsePlan(text: string): Subtask[] | null {
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf("[");
  const jsonEnd = trimmed.lastIndexOf("]");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) return null;
  const json = trimmed.slice(jsonStart, jsonEnd + 1);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const subtasks: Subtask[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const prompt = String(record.prompt ?? "").trim();
    if (!prompt) continue;
    const role = typeof record.role === "string" && VALID_ROLES.has(record.role) ? record.role : "builder";
    subtasks.push({ id: nextSubId(), role: role as AgentRole, prompt, status: "pending" });
  }
  return subtasks.length > 0 ? subtasks : null;
}
