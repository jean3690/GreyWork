import type { AgentRole } from "./types";

export type WorkflowStepKind = "collect" | "analyze" | "report" | "render" | "review";

export interface WorkflowStep {
  id: string;
  kind: WorkflowStepKind;
  label: string;
  agentRole: AgentRole;
  skillId?: string;
  dependsOn?: string[];
  description?: string;
}

export type WorkflowStatus = "draft" | "running" | "completed" | "failed";

export interface WorkflowPlan {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  status: WorkflowStatus;
  progress: number;
}

export interface WorkflowStepResult {
  stepId: string;
  ok: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}

export interface WorkflowExecutor {
  runStep(step: WorkflowStep, context: { plan: WorkflowPlan }): Promise<WorkflowStepResult>;
}

export function createWorkflowPlan(id: string, name: string, steps: WorkflowStep[], description?: string): WorkflowPlan {
  return { id, name, steps, description, status: "draft", progress: 0 };
}

/** 空间报告流水线：数据采集 → 空间分析 → 报告生成 → 审查 */
export function defaultSpatialReportPlan(seed = "report-001"): WorkflowPlan {
  return createWorkflowPlan(
    seed,
    "城市态势空间报告",
    [
      {
        id: "collect",
        kind: "collect",
        label: "采集空间数据",
        agentRole: "geo-analyst",
        skillId: "skill-gis",
        description: "读取 GeoJSON / MBTiles / 3D Tiles 源",
      },
      {
        id: "analyze",
        kind: "analyze",
        label: "DuckDB 空间分析",
        agentRole: "geo-analyst",
        skillId: "skill-gis",
        dependsOn: ["collect"],
        description: "包围盒/最近邻/聚合查询",
      },
      {
        id: "report",
        kind: "report",
        label: "生成分析报告",
        agentRole: "researcher",
        skillId: "skill-report",
        dependsOn: ["analyze"],
        description: "生成 Markdown/PDF 报告",
      },
      {
        id: "review",
        kind: "review",
        label: "质量审查",
        agentRole: "reviewer",
        dependsOn: ["report"],
        description: "数据一致性与产出校验",
      },
    ],
    "自动完成 数据采集 → 分析 → 报告 的完整闭环",
  );
}

export async function runWorkflow(plan: WorkflowPlan, executor: WorkflowExecutor): Promise<WorkflowPlan> {
  plan.status = "running";
  const completed = new Set<string>();
  for (const step of plan.steps) {
    const depsOk = (step.dependsOn ?? []).every((id) => completed.has(id));
    if (!depsOk) {
      plan.status = "failed";
      break;
    }
    const result = await executor.runStep(step, { plan });
    if (!result.ok) {
      plan.status = "failed";
      break;
    }
    completed.add(step.id);
    plan.progress = Math.round((completed.size / plan.steps.length) * 100);
  }
  if (plan.status === "running") plan.status = "completed";
  return plan;
}
