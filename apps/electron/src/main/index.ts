/**
 * Electron 主进程入口。
 *
 * 编排：**单实例锁** → `whenReady` → 读/建本机凭据 → 起 `greywork-server` sidecar →
 * 注册 IPC → 建无边框主窗（自动登录）→ 建托盘。sidecar 意外退出即随主进程退出，避免留下
 * 「壳还在、后端没了」的半死状态。应用退出时收掉 sidecar。
 */
import { app, type BrowserWindow } from "electron";

import { isDevServerEnabled, sidecarOrigin } from "../shared/dev-server-spec";
import { loadOrCreateCredentials } from "./auth";
import { destroyBrowserView } from "./browser-view";
import { startDevServer, stopDevServer } from "./dev-server";
import { registerIpc } from "./ipc";
import { serverBinaryPath } from "./paths";
import { startServer, stopServer } from "./sidecar";
import { createTray, type TrayHost } from "./tray";
import { createMainWindow } from "./window";

let mainWindow: BrowserWindow | null = null;
let sidecarPort = 0;
/** sidecar 的登录密码。窗口重建（macOS 点 Dock 图标）时要再用一次。 */
let sidecarPassword = "";
/**
 * 渲染端载入的 origin。热更态是 Vite dev server（`/api` 反代到 sidecar），否则是 sidecar 同源。
 * 主窗与插件悬浮窗都读它 —— 两处必须是同一个 origin，否则会混用两份产物 / 两份会话。
 */
let rendererOrigin = "";
let quitting = false;

/** 托盘 / 关窗守卫共用的宿主面：窗口是懒取（托盘可能先于窗口建成）。 */
const trayHost: TrayHost = {
  window: () => mainWindow,
  quit: () => {
    quitting = true;
    app.quit();
  },
};

/**
 * 建主窗并登记「关窗即清引用」。首次启动与 macOS 重开都走这里 —— 两处的差别只有触发时机。
 *
 * 复用同一份 sidecar 端口与密码：sidecar 还活着，没必要（也不该）重启一个后端。
 */
async function openMainWindow(): Promise<void> {
  const win = await createMainWindow({
    port: sidecarPort,
    password: sidecarPassword,
    origin: rendererOrigin,
    openDevTools: process.env.GREYWORK_ELECTRON_DEVTOOLS === "1",
    tray: trayHost,
  });
  mainWindow = win;
  win.on("closed", () => {
    destroyBrowserView(win);
    if (mainWindow === win) mainWindow = null;
  });
}

app.on("window-all-closed", () => {
  // macOS 惯例：关掉所有窗不退出应用（Dock 仍在）。其余平台关窗即退。
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  // macOS：关掉所有窗后点 Dock 图标要能重开窗口（Tauri 侧对应 `Reopen` 事件）。
  // 已有窗口时交给系统聚焦即可，不重复建。
  if (mainWindow || !sidecarPort) return;
  void openMainWindow().catch((error: unknown) => {
    console.error("[electron] 重开主窗失败：", error);
  });
});

app.on("before-quit", () => {
  quitting = true;
  stopServer();
  stopDevServer();
});

// 单实例守卫（对齐 tauri-plugin-single-instance）：重复启动不再起第二个进程，而是把已有窗口叫回来。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app
    .whenReady()
    .then(async () => {
      const credentials = loadOrCreateCredentials(serverBinaryPath());
      const sidecar = await startServer(credentials.hash);
      sidecarPort = sidecar.port;
      sidecarPassword = credentials.password;
      sidecar.process.on("exit", (code) => {
        if (!quitting) {
          console.error(`[electron] sidecar 意外退出（code=${code}），随主进程退出`);
          app.quit();
        }
      });

      // 渲染端 origin：默认 sidecar 同源托管；热更态改由 Vite dev server 提供（顺序不能反 ——
      // Vite 的 `/api` 反代 target 就是刚起的 sidecar 端口）。
      rendererOrigin = sidecarOrigin(sidecar.port);
      if (isDevServerEnabled(app.isPackaged, process.env)) {
        rendererOrigin = (await startDevServer({ sidecarPort: sidecar.port })).origin;
        console.log(`[dev] 热更模式：渲染端载入 ${rendererOrigin}`);
      }

      registerIpc({
        window: () => mainWindow,
        rendererOrigin: () => rendererOrigin,
        quit: trayHost.quit,
      });

      await openMainWindow();

      // 托盘在窗口之后建：托盘菜单的回调要能叫回窗口（懒取，先建也不会错，但顺序更直观）。
      createTray(trayHost);
    })
    .catch((error: unknown) => {
      console.error("[electron] 启动失败：", error);
      app.quit();
    });
}
