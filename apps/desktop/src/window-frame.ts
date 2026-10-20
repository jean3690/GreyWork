/**
 * Linux 桌面主窗的圆角接线（macOS / Windows 由系统原生裁，不走这里）。
 *
 * Electron 30 在 Linux 上不支持 `roundedCorners`，所以主窗被建成了透明的无边框窗口
 * （见 `apps/electron/src/main/window.ts`）：本模块只在**主窗**的 `<html>` 上打
 * `data-native-shell`，`theme/base.css` 据此把 html/body 的兜底底色改透明，并给 `#app`
 * 加底色、`border-radius` 与 `overflow: hidden`。圆角外的像素因此透出桌面，窗口才像
 * 一块浮起来的卡片。
 *
 * 两处边界：
 * - **插件悬浮窗不参与**：它同样是 Electron 窗口，但本身就是透明的自由形态（宠物 / 挂件），
 *   整窗裁圆角会把它们切坏。主窗与悬浮窗只差 label，用 `MAIN_WINDOW_LABEL` 区分。
 * - **最大化时去掉圆角**：窗口铺满工作区后，四角再圆就会把桌面漏出来。状态由 `onResized`
 *   回灌 —— 最大化 / 还原都会触发它（与 Titlebar 读的是同一份宿主事实）。
 */
import { hostWindow, MAIN_WINDOW_LABEL, type HostWindow } from "@greywork/host-ipc";

/** 与 `theme/base.css` 的选择器一一对应（dataset 的驼峰写法映射到 data-kebab）。 */
const SHELL_ATTR = "nativeShell";
const MAXIMIZED_ATTR = "nativeMaximized";

/**
 * 给 Linux 主窗装上圆角标记并跟随最大化状态。
 *
 * 非主窗、非 Linux、无窗口宿主（浏览器预览、自托管 Web）都是空操作。
 * 只在入口调用一次：窗口的生命周期与进程一致，不需要退订。
 */
export function installWindowFrame(win: HostWindow | null = hostWindow()): void {
  if (!win || win.label !== MAIN_WINDOW_LABEL || win.platform !== "linux") return;

  const root = document.documentElement;
  root.dataset[SHELL_ATTR] = "";

  const syncMaximized = (): void => {
    void win
      .isMaximized()
      .then((maximized) => {
        if (maximized) root.dataset[MAXIMIZED_ATTR] = "";
        else delete root.dataset[MAXIMIZED_ATTR];
      })
      .catch((error: unknown) => console.error("[window-frame] 读取窗口最大化状态失败", error));
  };

  // 窗口可能带着「上次最大化」的状态启动（window-state.ts），所以先同步一次。
  syncMaximized();
  void win.onResized(syncMaximized).catch((error: unknown) => console.error("[window-frame] 订阅窗口尺寸变化失败", error));
}
