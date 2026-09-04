/**
 * 设置存储双态后端（P1：settings 真库化）。
 *
 * - Tauri 桌面态：SQLite meta.settings 真源（db_settings_load / db_settings_sync）。
 * - 浏览器态：无后端 → load null / save no-op，store 维持 localStorage。
 *
 * 设置对象整体读写（后端不解析字段）；校验归 settings store 的 applySaved。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@greywork/core";

/** 宽松快照形状（与 SavedSettings 同构；store 侧校验）。 */
export type SettingsSnapshot = Record<string, unknown>;

export const settingsBackend = {
  /** 当前运行时是否有后端真源（Tauri 桌面）。 */
  active(): boolean {
    return isTauriRuntime();
  },

  /** 读设置快照；从未持久化过 → null（store 以本地/默认值回填并首落库）。 */
  async load(): Promise<SettingsSnapshot | null> {
    if (!isTauriRuntime()) return null;
    return await invoke<SettingsSnapshot | null>("db_settings_load");
  },

  /** 全量替换设置快照（单对象 upsert）。 */
  async save(settings: SettingsSnapshot): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("db_settings_sync", { settings });
  },
};
