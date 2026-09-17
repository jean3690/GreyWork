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

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@greywork/core";

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

export const automationsBackend = {
  /** 当前运行时是否有后端真源（Tauri 桌面）。 */
  active(): boolean {
    return isTauriRuntime();
  },

  /** 读任务清单；库未接管 → null（store 以种子回填并首落库）。 */
  async load(): Promise<AutomationTaskRow[] | null> {
    if (!isTauriRuntime()) return null;
    return await invoke<AutomationTaskRow[] | null>("db_automations_load");
  },

  /** 全量替换任务清单（事务幂等）。 */
  async save(tasks: AutomationTaskRow[]): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("db_automations_sync", { tasks });
  },

  /** 拉取到期执行队列：pending 且到期在最近 60min 窗口内。 */
  async dueList(): Promise<AutomationDueRow[] | null> {
    if (!isTauriRuntime()) return null;
    return await invoke<AutomationDueRow[]>("db_automations_due_list");
  },

  /** 完成认领到期任务（pending → success/failed；库侧原子防双执行）。 */
  async dueFinish(id: number, status: "success" | "failed"): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("db_automations_due_finish", { id, status });
  },
};
