/**
 * 系统通知。
 *
 * 两条来路：
 * - 插件能力 `notify`（命令 `plugin_notify`）：标题要加 `[pluginId] ` 归属前缀（组装见
 *   `shared/notify-compose.ts`，与 Rust 侧 `compose_plugin_notify` 对齐）；
 * - 壳自己的提示（如首次隐藏到托盘）：`sendSystemNotification`。
 *
 * 失败即降级：无通知守护进程（Linux 无 daemon）、macOS 未授权等情况只记日志 —— 通知是旁路
 * 上报，绝不能反过来影响主流程（与 Tauri 壳 `notify.rs` 同一条原则）。
 */
import { Notification } from "electron";

import { composePluginNotify, type PluginNotifyRequest } from "../shared/notify-compose";

/** 发一条系统通知；不支持 / 失败只记日志。 */
export function sendSystemNotification(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) {
      console.warn("[notify] 当前环境不支持系统通知，已丢弃：", title);
      return;
    }
    new Notification({ title, body }).show();
  } catch (error) {
    console.warn("[notify] 发送失败（已忽略）：", error);
  }
}

/** 插件通知：组装归属前缀后直接发（文案组装见 shared/notify-compose.ts）。 */
export function notifyPlugin(request: PluginNotifyRequest): { title: string; body: string } {
  const composed = composePluginNotify(request);
  sendSystemNotification(composed.title, composed.body);
  return composed;
}
