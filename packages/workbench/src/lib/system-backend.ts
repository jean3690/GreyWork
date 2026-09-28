/**
 * 系统诊断后端：设置页「系统 → 关于」卡消费。
 * - 桌面态：Rust `sys_info` 经 Tauri IPC。
 * - 服务端态：同一命令经 `POST /api/command` —— 实现收在共享 crate，两边是同一份。
 * - 浏览器预览态：无宿主 → null（卡显示「无宿主诊断面」）。
 */

import { invoke, hasHostCommands } from "@greywork/host-ipc";

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
   * 否则窗口藏起来后没有任何入口能恢复），设置页据此不给选。服务端恒 false。
   */
  trayAvailable: boolean;
  /** 物理内存总量（字节）；宿主取不到为 null（Windows 等平台回落渲染端探测）。 */
  totalMemoryBytes: number | null;
  /** 逻辑核数；取不到为 0。设备分级用它判低端（见 lib/device-tier.ts）。 */
  cpuCount: number;
  /**
   * 宿主是否钉死了 agent 沙箱（服务端配了 `GREYWORK_SANDBOX` 时为真）。
   *
   * 钉住后客户端传什么都会被 `policy::overlay_args` 改写成配置值 —— 设置页若还
   * 让改沙盒档位就是一个骗人的开关，据此置灰并说明。桌面端没有配置覆盖，恒 false。
   */
  pinnedSandbox: boolean;
  /**
   * 宿主钉死的权限档位（服务端配了 `GREYWORK_TIER` 时有值）。
   *
   * 同上：钉住后 `acp_start` / `acp_set_permission_tier` 的档位都被改写成配置值，
   * 设置页据此把权限档位卡置灰并说明。桌面端恒 null。
   */
  pinnedTier: string | null;
}

export const systemBackend = {
  active(): boolean {
    return hasHostCommands();
  },

  /** 拉取系统诊断快照；浏览器预览态返回 null。 */
  async info(): Promise<SysInfo | null> {
    if (!hasHostCommands()) return null;
    return await invoke<SysInfo>("sys_info");
  },
};
