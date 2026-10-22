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
import * as guard from "./close-guard";
import { startDevServer, stopDevServer } from "./dev-server";
import { registerIpc } from "./ipc";
import { installFileLogging } from "./logger";
import { installApplicationMenu } from "./menu";
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

/**
 * 逃生舱：置 `1` 时关掉硬件加速（整窗软件渲染）。
 *
 * 起因是 WSLg：那里的 dzn（Vulkan-on-D3D12）不是合规实现，GPU 进程初始化失败时偶尔会把浏览器
 * 进程一起带崩 —— 表现为启动几秒后 SIGSEGV，终端里只剩一行 `Exiting GPU process`。软件渲染下
 * 圆角 / 透明仍然有效，代价是预览、终端这些面板吃 CPU。
 */
const DISABLE_GPU_ENV = "GREYWORK_DISABLE_GPU";

// Linux/X11 下透明窗口需要 ARGB visual 才会真的透出桌面（主窗圆角靠它，见 window.ts）。
// 不加 `--disable-gpu`：那只是旧版 NVIDIA 驱动下 alpha 失效的兜底，代价是整窗软件渲染，
// 对预览 / 终端这些吃 GPU 的面板得不偿失 —— 于是做成显式开关，只在踩到崩溃时关。
if (process.platform === "linux") app.commandLine.appendSwitch("enable-transparent-visuals");
if (process.env[DISABLE_GPU_ENV] === "1") {
  app.disableHardwareAcceleration();
  console.log("[main] 已关闭硬件加速（" + DISABLE_GPU_ENV + "=1）");
}

/** 托盘 / 关窗守卫共用的宿主面：窗口是懒取（托盘可能先于窗口建成）。 */
const trayHost: TrayHost = {
  window: () => mainWindow,
  // 只调 app.quit()：让 before-quit 的退出守卫先跑。真正的退出标记在那里置位，
  // 有未保存改动时渲染端会收到 exitRequested 并决定收口。
  quit: () => app.quit(),
  openWindow: async () => {
    if (!mainWindow) await openMainWindow();
    return mainWindow;
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

// Windows 通知 / 任务栏分组要靠 AppUserModelID；值必须与 electron-builder 的 appId 一致。
if (process.platform === "win32") app.setAppUserModelId("com.greywork.desktop");

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

app.on("before-quit", (event) => {
  if (quitting) return;
  const win = mainWindow;
  // 有未保存改动时拦下退出，交给渲染端走保存 / 确认流程；确认后 confirmExit() 会
  // 先 release() 再 app.quit()，这次 before-quit 就能通过。
  if (win && !win.isDestroyed() && guard.shouldInterceptExit(true)) {
    event.preventDefault();
    // 关闭到托盘后窗口是隐藏的：确认弹层要能被看见。
    win.show();
    win.focus();
    guard.handExitToRenderer(win);
    return;
  }
  quitting = true;
  // 放行关窗守卫：主窗的 close 处理器会先看 isReleased()，不放行的话「关闭到托盘」会在
  // app.quit() 关窗时把窗口藏起来 —— 没有窗口真正被关闭，will-quit 永不触发，托盘「退出」
  // 就成了「再藏一次」，应用退不掉。
  guard.release();
});

// sidecar / Vite 必须等窗口真正收完再停：退出守卫可能把 before-quit 拦下来（用户取消），
// 那时后端还得活着；will-quit 不会被取消，是唯一安全的收尾点。
app.on("will-quit", () => {
  stopServer();
  stopDevServer();
});

// 单实例守卫（对齐 tauri-plugin-single-instance）：重复启动不再起第二个进程，而是把已有窗口叫回来。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // 窗口被关掉但进程还活着（macOS）：重复启动应该把窗口建回来，而不是什么都不做。
    if (!mainWindow) {
      if (sidecarPort) {
        void openMainWindow().catch((error: unknown) => {
          console.error("[electron] 二次启动重开主窗失败：", error);
        });
      }
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app
    .whenReady()
    .then(async () => {
      // 先装日志：后面的 sidecar / 登录 / 窗口失败才有落盘现场。
      installFileLogging();
      installApplicationMenu({ dev: !app.isPackaged });

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
