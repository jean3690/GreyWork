import type { AgentLoopConfig, Agent, AgentStatus } from "./types";
import type { WorkflowPlan, WorkflowStep, WorkflowStepResult } from "./workflow";

export interface AgentLoopState {
  round: number;
  config: AgentLoopConfig;
  history: AgentStepRecord[];
}

export interface AgentStepRecord {
  round: number;
  agentId: string;
  action: string;
  tool?: string;
  command?: string;
  result?: string;
}

export function createAgentLoopState(_agent: Agent, config: AgentLoopConfig): AgentLoopState {
  return { round: 0, config, history: [] };
}

export function nextRound(state: AgentLoopState, record: AgentStepRecord): AgentLoopState {
  return {
    ...state,
    round: state.round + 1,
    history: [...state.history, record],
  };
}

export function loopExhausted(state: AgentLoopState): boolean {
  return state.round >= state.config.maxRounds;
}

export function stepToResult(step: WorkflowStep, ok: boolean, output: string): WorkflowStepResult {
  return {
    stepId: step.id,
    ok,
    output,
    error: ok ? undefined : "step failed",
    durationMs: 0,
  };
}

export function planProgressText(plan: WorkflowPlan): string {
  return `${plan.name} · ${plan.progress}% · ${plan.status}`;
}

export function agentStatusLabel(status: AgentStatus): string {
  const labels: Record<AgentStatus, string> = {
    idle: "待命",
    working: "工作中",
    blocked: "阻塞",
    offline: "离线",
  };
  return labels[status];
}
