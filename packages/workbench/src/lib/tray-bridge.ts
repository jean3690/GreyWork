/**
 * 系统托盘 ↔ 渲染端的桥，经 `@greywork/host-ipc` 的 `hostTray()` 门面抹平后端
 * （Tauri: src-tauri/src/tray.rs；Electron: electron/electron/main.ts）。
 *
 * 两件「宿主需要一个渲染端才持有的值」在这里下发：
 * - 「关闭到托盘」偏好：存在设置快照里，宿主要在关窗时读它决定拦不拦，由 Shell 的 watch 调
 *   `syncCloseToTray`（immediate 先送默认/缓存值，设置库水合后若不同再送一次，不丢偏好）。
 * - 托盘菜单文案：宿主不持有语言，Shell 在语言切换时整份重推 `syncTrayLabels`。
 *
 * 菜单点击经宿主事件广播回来，`useTrayBridge` 订阅后转成应用内动作。
 * 无窗口宿主（服务端 / 浏览器态）一律空转。
 */
import { hostTray, type TrayLabels } from "@greywork/host-ipc";

export type { TrayLabels };

/** 把「关闭到托盘」同步给宿主；无托盘宿主静默跳过。 */
export async function syncCloseToTray(enabled: boolean): Promise<void> {
  const tray = hostTray();
  if (!tray) return;
  try {
    await tray.setCloseToTray(enabled);
  } catch (error: unknown) {
    console.error("[tray] 同步「关闭到托盘」偏好失败", error);
  }
}

/** 把托盘菜单文案同步给宿主；无托盘宿主静默跳过。 */
export async function syncTrayLabels(labels: TrayLabels): Promise<void> {
  const tray = hostTray();
  if (!tray) return;
  try {
    await tray.setLabels(labels);
  } catch (error: unknown) {
    console.error("[tray] 同步托盘菜单文案失败", error);
  }
}

export interface TrayBridgeHandlers {
  onNewChat: () => void;
  onOpenSettings: () => void;
}

/**
 * 订阅托盘菜单事件，返回解绑函数。订阅是异步落地的：期间若组件已卸载，落地后立刻退订。
 */
export function useTrayBridge(handlers: TrayBridgeHandlers): () => void {
  const tray = hostTray();
  if (!tray) return () => {};

  let dispose = (): void => {};
  let disposed = false;

  void (async () => {
    try {
      const off = await tray.onEvent({ newChat: handlers.onNewChat, openSettings: handlers.onOpenSettings });
      if (disposed) {
        off();
        return;
      }
      dispose = off;
    } catch (error: unknown) {
      console.error("[tray] 订阅托盘事件失败", error);
    }
  })();

  return () => {
    disposed = true;
    dispose();
  };
}
