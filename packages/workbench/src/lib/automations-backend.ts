/**
 * 自动化任务存储双态后端（P2：automations 真库化）。
 *
 * - Tauri 桌面态：SQLite automation_tasks 真源（db_automations_load / db_automations_sync）；
 *   Rust 调度器每 30s tick 读库判 cron，到期经 `automation://due` 广播（本文件不处理事件，
 *   监听在 automation store 内）。
 * - 浏览器态：无后端 → load null / save no-op，store 维持 localStorage。
 *
 * 任务行形状与 Rust `AutomationTaskDto` 对齐（running 为运行期瞬时态不落库）。
 */

import { hasHostCommands, invoke } from "@greywork/host-ipc";

export interface AutomationTaskRow {
  id: string;
  name: string;
  /** 人类可读触发描述（如「每天 09:00」）。 */
  schedule: string;
  /** 标准 cron 5 段表达式；null/缺省 = 手动触发。 */
  cron: string | null;
  /** 一次性任务的触发时刻（epoch ms）；null/缺省 = 按 cron 循环。 */
  onceAt: number | null;
  /** 执行后端：ACP 后端 id；null = 本机模型管线。 */
  acpProviderId: string | null;
  target: string;
  intent: string;
  enabled: boolean;
  /** 最近一次运行时间戳（epoch ms；0 = 从未）。 */
  lastRun: number;
}

/** 宿主 tick 广播的到期载荷（与 Rust AutomationDuePayload 对齐）。 */
export interface AutomationDuePayload {
  id: string;
  name: string;
  target: string;
  intent: string;
}

/** 到期执行队列行（宿主持久化入队；与 Rust AutomationDueDto 对齐）。 */
export interface AutomationDueRow {
  id: number;
  taskId: string;
  name: string;
  target: string;
  intent: string;
  /** 入队时刻的执行后端快照（与 intent 同源）；null = 本机模型管线。 */
  acpProviderId: string | null;
  dueAt: number;
}

/**
 * 运行记录行（宿主与渲染端两条执行路径共用；与 Rust AutomationRunDto 对齐）。
 * status: 成功/失败；sessionId: 关联会话（宿主兜底执行也建会话，可点进查看）；
 * mode: llm=本机模型 / acp=指定后端 / host=宿主无人值守兜底。
 */
export interface AutomationRunRow {
  id: number;
  taskId: string;
  name: string;
  status: "success" | "failed";
  detail: string | null;
  sessionId: string | null;
  mode: "llm" | "acp" | "host";
  ranAt: number;
}

export const automationsBackend = {
  /** 当前运行时是否有后端真源（Tauri 桌面）。 */
  active(): boolean {
    return hasHostCommands();
  },

  /** 读任务清单；库未接管 → null（store 以种子回填并首落库）。 */
  async load(): Promise<AutomationTaskRow[] | null> {
    if (!hasHostCommands()) return null;
    return await invoke<AutomationTaskRow[] | null>("db_automations_load");
  },

  /** 全量替换任务清单（事务幂等）。 */
  async save(tasks: AutomationTaskRow[]): Promise<void> {
    if (!hasHostCommands()) return;
    await invoke("db_automations_sync", { tasks });
  },

  /** 拉取到期执行队列：pending 且到期在最近 60min 窗口内。 */
  async dueList(): Promise<AutomationDueRow[] | null> {
    if (!hasHostCommands()) return null;
    return await invoke<AutomationDueRow[]>("db_automations_due_list");
  },

  /** 完成认领到期任务（pending → success/failed；库侧原子防双执行）。 */
  async dueFinish(id: number, status: "success" | "failed"): Promise<void> {
    if (!hasHostCommands()) return;
    await invoke("db_automations_due_finish", { id, status });
  },

  /** 读运行记录（按 ranAt 倒序，默认最近 200 条）；浏览器态无后端 → 空。 */
  async runsLoad(limit = 200): Promise<AutomationRunRow[]> {
    if (!hasHostCommands()) return [];
    return (await invoke<AutomationRunRow[]>("db_automation_runs_load", { limit })) ?? [];
  },

  /** 记一条运行结果（每任务库侧自动裁剪保留最近 50 条）。 */
  async runRecord(run: Omit<AutomationRunRow, "id">): Promise<void> {
    if (!hasHostCommands()) return;
    await invoke("db_automation_run_record", { run });
  },
};
