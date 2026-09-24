import { isTauriRuntime } from "@greywork/core";
import { invoke } from "@greywork/host-ipc";

/**
 * 插件悬浮窗的宿主桥。
 *
 * 窗口由 Rust 宿主托管（插件代码永远拿不到句柄）：桌面态经 Tauri IPC 建/关 OS 级窗口，
 * 浏览器预览与单测下为 no-op（无窗口概念）。开窗入口在 PluginRegionHost，
 * 停用/卸载时的回收由 runtime/market 调 closePluginWindow —— 两者共用这一条通道。
 */
export interface PluginWindowHost {
  open(pluginId: string): Promise<void>;
  close(pluginId: string): Promise<void>;
}

/** 测试注入的宿主实现；非空时优先于默认 Tauri 通道。 */
let hostOverride: PluginWindowHost | null = null;

async function resolveHost(): Promise<PluginWindowHost | null> {
  if (hostOverride) return hostOverride;
  // 守卫必须留在 isTauriRuntime 而非 hasHostCommands：plugin_window_* 是**仅桌面端**命令，
  // 服务端会以 403 拒绝，服务端模式下这里就该是 no-op。
  if (!isTauriRuntime()) return null;
  return {
    open: (pluginId) => invoke("plugin_window_open", { pluginId }),
    close: (pluginId) => invoke("plugin_window_close", { pluginId }),
  };
}

/** 测试 seam：注入/清除宿主实现（生产走默认 Tauri 通道）。 */
export function setPluginWindowHostForTest(next: PluginWindowHost | null): void {
  hostOverride = next;
}

export async function openPluginWindow(pluginId: string): Promise<void> {
  const host = await resolveHost();
  if (!host) return;
  await host.open(pluginId);
}

/** 关闭悬浮窗（停用/卸载插件时回收）。窗口不存在或宿主不可用时静默成功。 */
export async function closePluginWindow(pluginId: string): Promise<void> {
  const host = await resolveHost();
  if (!host) return;
  try {
    await host.close(pluginId);
  } catch {
    // 关窗失败不应中断停用/卸载流程。
  }
}
