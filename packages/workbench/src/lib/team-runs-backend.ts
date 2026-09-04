/**
 * 编排运行存档双态后端（P3：PlannerRun 历史真库化）。
 *
 * - Tauri 桌面态：SQLite team_runs 真源（db_team_runs_load / db_team_runs_sync）。
 * - 浏览器态：无后端 → load null / save no-op，agent store 以 localStorage 缓存兜底。
 *
 * 存档行：PlannerRun 全文不透明 JSON（Rust 只校验 id 一致，不解析内部结构）。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@greywork/core";

export interface TeamRunRow {
  id: string;
  /** PlannerRun 全文（不透明 JSON，由 store 断言类型）。 */
  payload: unknown;
}

export const teamRunsBackend = {
  /** 当前运行时是否有后端真源（Tauri 桌面）。 */
  active(): boolean {
    return isTauriRuntime();
  },

  /** 读存档；库未接管 → null（store 以本地缓存回填并首落库）。 */
  async load(): Promise<TeamRunRow[] | null> {
    if (!isTauriRuntime()) return null;
    return await invoke<TeamRunRow[] | null>("db_team_runs_load");
  },

  /** 全量替换存档（事务幂等；运行结束后写一次）。 */
  async save(runs: TeamRunRow[]): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("db_team_runs_sync", { runs });
  },
};
