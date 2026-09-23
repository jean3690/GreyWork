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
  /**
   * 宿主是否真的建出了系统托盘。
   *
   * 没有托盘时「关闭到托盘」是无效档位（宿主会把关闭行为钳回「关闭即退出」，
   * 否则窗口藏起来后没有任何入口能恢复），设置页据此不给选。
   */
  trayAvailable: boolean;
  /** 物理内存总量（字节）；宿主取不到为 null（Windows 等平台回落渲染端探测）。 */
  totalMemoryBytes: number | null;
  /** 逻辑核数；取不到为 0。设备分级用它判低端（见 lib/device-tier.ts）。 */
  cpuCount: number;
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
