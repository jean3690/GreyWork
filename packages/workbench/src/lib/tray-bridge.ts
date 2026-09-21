/**
 * 系统托盘 ↔ 渲染端的桥。
 *
 * 托盘本体在 Rust 侧（apps/desktop/src-tauri/src/tray.rs）：菜单事件经 `app.emit`
 * 广播到前端，这里订阅后转成应用内动作（新建对话 / 打开设置由 Shell 提供）。
 *
 * 另外两件事也在这里，共同点是「宿主需要一个渲染端才持有的值」：
 * - 「关闭到托盘」偏好：存在设置快照里，而宿主要在 CloseRequested 里读它才能决定拦不拦，
 *   由 Shell 的 watch 调 syncCloseToTray。顺序：watch immediate 先送当前（默认 / 本地缓存）
 *   值；设置从库水合完成后若真值不同会再触发一次，因此不会丢偏好。
 * - 托盘菜单文案：宿主不持有语言，由 Shell 在语言切换时重推 syncTrayLabels。
 *
 * 浏览器态一律空转（没有 IPC 宿主，invoke / listen 必然失败）。
 */
import { isTauriRuntime } from "@greywork/core";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 与 src-tauri/src/tray.rs 的事件名常量同名 —— 改一边必须改另一边。 */
const EVENT_NEW_CHAT = "tray:new-chat";
const EVENT_OPEN_SETTINGS = "tray:open-settings";

/**
 * 托盘菜单文案（与 src-tauri/src/tray.rs 的 `TrayLabels` 字段同名，camelCase）。
 * 宿主不持有语言，语言切换时整份重推。
 */
export interface TrayLabels {
  toggleWindow: string;
  newChat: string;
  settings: string;
  quit: string;
  /** 首次隐藏窗口时的提示正文；空串则不发系统通知。 */
  hiddenHint: string;
}

/** 把「关闭到托盘」同步给宿主；浏览器态静默跳过。 */
export async function syncCloseToTray(enabled: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("set_close_to_tray", { enabled });
  } catch (error: unknown) {
    console.error("[tray] 同步「关闭到托盘」偏好失败", error);
  }
}

/** 把托盘菜单文案同步给宿主；浏览器态静默跳过。 */
export async function syncTrayLabels(labels: TrayLabels): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("set_tray_labels", { labels });
  } catch (error: unknown) {
    console.error("[tray] 同步托盘菜单文案失败", error);
  }
}

export interface TrayBridgeHandlers {
  onNewChat: () => void;
  onOpenSettings: () => void;
}

/**
 * 订阅托盘菜单事件，返回解绑函数。
 *
 * 事件名是自定义的 `tray:` 前缀（不是 Tauri 保留的 `tauri://`），走普通 listen。
 * listen 是异步落地的：期间若组件已卸载，落地后要立刻退订，否则会漏掉解绑。
 */
export function useTrayBridge(handlers: TrayBridgeHandlers): () => void {
  if (!isTauriRuntime()) return () => {};

  const unlisteners: UnlistenFn[] = [];
  let disposed = false;

  void (async () => {
    try {
      const [offNewChat, offOpenSettings] = await Promise.all([
        listen(EVENT_NEW_CHAT, () => handlers.onNewChat()),
        listen(EVENT_OPEN_SETTINGS, () => handlers.onOpenSettings()),
      ]);
      if (disposed) {
        offNewChat();
        offOpenSettings();
        return;
      }
      unlisteners.push(offNewChat, offOpenSettings);
    } catch (error: unknown) {
      console.error("[tray] 订阅托盘事件失败", error);
    }
  })();

  return () => {
    disposed = true;
    for (const off of unlisteners) off();
    unlisteners.length = 0;
  };
}
