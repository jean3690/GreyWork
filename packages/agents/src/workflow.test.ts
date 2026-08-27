import { describe, expect, it } from "vitest";
import {
  createWorkflowPlan,
  defaultSpatialReportPlan,
  runWorkflow,
  type WorkflowExecutor,
  type WorkflowPlan,
  type WorkflowStep,
  type WorkflowStepResult,
} from "./workflow";

/** 按调用顺序记录 stepId 的 executor 工厂 */
function recordingExecutor(
  failAt?: string,
  results: Record<string, Partial<WorkflowStepResult>> = {},
): { executor: WorkflowExecutor; ran: string[] } {
  const ran: string[] = [];
  const executor: WorkflowExecutor = {
    async runStep(step) {
      ran.push(step.id);
      if (step.id === failAt) {
        return {
          stepId: step.id,
          ok: false,
          error: "boom",
          durationMs: 1,
          ...results[step.id],
        };
      }
      return {
        stepId: step.id,
        ok: true,
        output: `done:${step.id}`,
        durationMs: 1,
        ...results[step.id],
      };
    },
  };
  return { executor, ran };
}

function twoStepPlan(): WorkflowPlan {
  return createWorkflowPlan("p1", "双步骤计划", [
    { id: "a", kind: "collect", label: "A", agentRole: "planner" },
    { id: "b", kind: "analyze", label: "B", agentRole: "researcher", dependsOn: ["a"] },
  ]);
}

describe("createWorkflowPlan", () => {
  it("初始状态为 draft 且 progress 为 0", () => {
    const plan = createWorkflowPlan("w-1", "计划", []);
    expect(plan.status).toBe("draft");
    expect(plan.progress).toBe(0);
    expect(plan.id).toBe("w-1");
    expect(plan.steps).toEqual([]);
  });

  it("description 未传时为 undefined", () => {
    expect(createWorkflowPlan("w", "n", []).description).toBeUndefined();
    expect(createWorkflowPlan("w", "n", [], "d").description).toBe("d");
  });
});

describe("defaultSpatialReportPlan", () => {
  it("步骤按 采集→分析→报告→审查 的顺序编排", () => {
    const plan = defaultSpatialReportPlan();
    expect(plan.steps.map((s) => s.id)).toEqual(["collect", "analyze", "report", "review"]);
  });

  it("依赖链线性且无环：每步只依赖其直接前驱", () => {
    const plan = defaultSpatialReportPlan();
    expect(plan.steps.map((s) => s.dependsOn ?? [])).toEqual([[], ["collect"], ["analyze"], ["report"]]);
  });

  it("seed 决定 plan id，默认 report-001；初始状态 draft/progress 0", () => {
    expect(defaultSpatialReportPlan().id).toBe("report-001");
    expect(defaultSpatialReportPlan("custom").id).toBe("custom");
    const plan = defaultSpatialReportPlan();
    expect(plan.status).toBe("draft");
    expect(plan.progress).toBe(0);
  });
});

describe("runWorkflow", () => {
  it("全部成功时按声明顺序执行各步并标记 completed/100%", async () => {
    const plan = twoStepPlan();
    const { executor, ran } = recordingExecutor();
    const result = await runWorkflow(plan, executor);
    // 步骤顺序即执行顺序（数组顺序，非拓扑排序）
    expect(ran).toEqual(["a", "b"]);
    expect(result.status).toBe("completed");
    expect(result.progress).toBe(100);
  });

  it("某步失败时立即停止：后续步骤不执行，status=failed，progress 只反映已完成步骤", async () => {
    const plan = createWorkflowPlan("p", "三步计划", [
      { id: "s1", kind: "collect", label: "", agentRole: "planner" },
      { id: "s2", kind: "analyze", label: "", agentRole: "planner" },
      { id: "s3", kind: "review", label: "", agentRole: "reviewer" },
    ]);
    const { executor, ran } = recordingExecutor("s2");
    const result = await runWorkflow(plan, executor);
    expect(ran).toEqual(["s1", "s2"]);
    expect(result.status).toBe("failed");
    // s1 已完成 → 33%；s2/s3 不计入
    expect(result.progress).toBe(33);
  });

  it("依赖未被满足（前序失败）时该步不执行", async () => {
    const plan = twoStepPlan();
    const { executor, ran } = recordingExecutor("a");
    await runWorkflow(plan, executor);
    expect(ran).toEqual(["a"]); // b 因 dependsOn: [a] 未完成而跳过
  });

  it("dependsOn 引用未知步骤 id 时判定失败且不执行任何步骤", async () => {
    const plan = createWorkflowPlan("p", "坏依赖", [
      { id: "only", kind: "render", label: "", agentRole: "spatial-artist", dependsOn: ["ghost"] },
    ]);
    const { executor, ran } = recordingExecutor();
    const result = await runWorkflow(plan, executor);
    expect(ran).toEqual([]);
    expect(result.status).toBe("failed");
    expect(result.progress).toBe(0);
  });

  it("空步骤列表直接 completed 且 progress 保持 0", async () => {
    const plan = createWorkflowPlan("p", "空计划", []);
    const { executor, ran } = recordingExecutor();
    const result = await runWorkflow(plan, executor);
    expect(ran).toEqual([]);
    expect(result.status).toBe("completed");
    expect(result.progress).toBe(0);
  });

  it("进度按完成比例四舍五入（3 步完成 1 步 = 33）", async () => {
    const plan = createWorkflowPlan("p", "三步", [
      { id: "x", kind: "collect", label: "", agentRole: "planner" },
      { id: "y", kind: "analyze", label: "", agentRole: "planner" },
      { id: "z", kind: "review", label: "", agentRole: "reviewer" },
    ]);
    const { executor } = recordingExecutor("y");
    const result = await runWorkflow(plan, executor);
    expect(result.progress).toBe(33);
  });

  it("失败后 status 不会被误标为 completed", async () => {
    // 回归保护：若实现漏掉 break 后的分支判断，failed 会被覆盖
    const plan = twoStepPlan();
    const { executor } = recordingExecutor("b");
    const result = await runWorkflow(plan, executor);
    expect(result.status).not.toBe("completed");
    expect(result.status).toBe("failed");
  });
});

describe("WorkflowStep 类型约束下的执行语义", () => {
  it("executor 能读到当前 plan 引用（上下文传递）", async () => {
    let seen: WorkflowPlan | undefined;
    const step: WorkflowStep = { id: "s", kind: "report", label: "", agentRole: "researcher" };
    const plan = createWorkflowPlan("ctx", "上下文", [step]);
    const executor: WorkflowExecutor = {
      async runStep(_step, context) {
        seen = context.plan;
        return { stepId: _step.id, ok: true, durationMs: 0 };
      },
    };
    await runWorkflow(plan, executor);
    expect(seen?.id).toBe("ctx");
  });
});
