/**
 * 系统诊断双态后端：设置页「系统 → 关于」卡消费。
 * - 桌面态：Rust `sys_info`（版本 / DB schema / 日志目录 / 活跃 ACP 进程 / OS）。
 * - 浏览器态：无宿主 → null（卡显示「浏览器预览」）。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@greywork/core";

export interface SysInfo {
  version: string;
  schemaVersion: number;
  logDir: string | null;
  activeAgents: number;
  os: string;
}

export const systemBackend = {
  active(): boolean {
    return isTauriRuntime();
  },

  /** 拉取系统诊断快照；浏览器态返回 null。 */
  async info(): Promise<SysInfo | null> {
    if (!isTauriRuntime()) return null;
    return await invoke<SysInfo>("sys_info");
  },
};
