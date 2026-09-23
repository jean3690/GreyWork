import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@greywork/core";
import { ref } from "vue";
import { refineDeviceTierFromHost } from "./device-tier";

/**
 * 宿主 OS（Rust 侧 `std::env::consts::OS`：`"macos"` / `"windows"` / `"linux"`）。
 *
 * 启动时由 `main.ts` 取一次 `sys_info` 落进来（与插件清单并发，不占关键路径）。
 * 取不到（浏览器态 / IPC 失败 / 还没回来）时保持 `null`，此时一律按**非 macOS** 渲染
 * —— 也就是 Windows/Linux 的既有布局，不会因为拿不到信息而退化成第三种样子。
 *
 * 用模块级 ref 而不是 Pinia store：这个请求在 `createPinia()` 之前就要发起，
 * 那时还没有 active pinia。
 */
export const hostOs = ref<string | null>(null);

/**
 * 取一次宿主系统快照；失败只记日志，绝不影响启动。
 *
 * 同一次 `sys_info` 顺带喂给设备分级（`totalMemoryBytes` / `cpuCount`）—— 这是宿主信息
 * 的唯一拉取点，低端判定里 WebKitGTK 拿不到 `navigator.deviceMemory`，只能靠它补齐。
 * 不额外发一次 IPC：这条链在启动关键路径之外，但重复调用纯属浪费。
 */
export async function loadHostSystem(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const info = await invoke<{ os?: string; totalMemoryBytes?: number | null; cpuCount?: number | null }>("sys_info");
    hostOs.value = info?.os ?? null;
    refineDeviceTierFromHost({
      totalMemoryBytes: info?.totalMemoryBytes ?? null,
      cpuCount: info?.cpuCount ?? null,
    });
  } catch (error: unknown) {
    console.warn("[platform] 读取宿主系统信息失败，按非 macOS 渲染", error);
  }
}
