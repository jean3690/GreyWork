import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@greywork/core";
import { ref } from "vue";

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

/** 取一次宿主 OS；失败只记日志，绝不影响启动。 */
export async function loadHostOs(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const info = await invoke<{ os?: string }>("sys_info");
    hostOs.value = info?.os ?? null;
  } catch (error: unknown) {
    console.warn("[platform] 读取宿主 OS 失败，按非 macOS 渲染", error);
  }
}
