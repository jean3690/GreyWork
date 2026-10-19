/**
 * 应用菜单。
 *
 * 主窗是 `frame: false`，菜单栏本来就不显示；但**默认菜单的加速键仍然生效**（打包态
 * Ctrl+R 重载、Ctrl+Shift+I 开 DevTools），对最终用户是意外行为。所以：
 *
 * - macOS：保留系统惯例菜单（App / 编辑 / 视图 / 窗口）—— 没有 App 菜单就没有 Cmd+Q、
 *   Cmd+H 这些系统级快捷键；
 * - Windows / Linux：直接 `setApplicationMenu(null)`，编辑快捷键由 Chromium 在
 *   webContents 内处理，不依赖菜单。
 */
import { Menu, type MenuItemConstructorOptions } from "electron";

export interface MenuOptions {
  /** 是否开发态：只有开发态才暴露「重载 / 开发者工具」。 */
  readonly dev: boolean;
}

export function installApplicationMenu(options: MenuOptions): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }

  const view: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      ...(options.dev ? [{ role: "reload" as const }, { role: "toggleDevTools" as const }] : []),
      ...(options.dev ? [{ type: "separator" as const }] : []),
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, view, { role: "windowMenu" }]),
  );
}
