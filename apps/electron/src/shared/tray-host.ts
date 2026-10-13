/**
 * 托盘宿主的**可用性判定**（纯函数：脱开 Electron / 子进程也能单测）。
 *
 * 背景：Linux 下即便没有 StatusNotifier/AppIndicator 宿主（WSLg、裸窗口管理器都没有），
 * `new Tray()` 也**不抛错**，图标只是静默不显示 —— 于是「可用」会被误判为真，点 X 把窗口藏进
 * 一个根本看不见的托盘，再也找不回、也退不出。所以判据取「会话总线上有没有注册
 * `org.kde.StatusNotifierWatcher`」（libappindicator / KDE / 带 AppIndicator 扩展的 GNOME
 * 都会注册它），两个探针都探不到（含工具缺失）即判不可用，关闭行为回落「关即退」。
 */

/** 探针输出里是否注册了 `StatusNotifierWatcher`；`null` 表示该探针没跑成。 */
export function trayHostPresentIn(outputs: readonly (string | null)[]): boolean {
  return outputs.some((output) => output !== null && output.includes("StatusNotifierWatcher"));
}
