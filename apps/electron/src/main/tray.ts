/**
 * 系统托盘（对齐 Tauri 壳 `tray.rs`）。
 *
 * 分工：**托盘本体在宿主侧，文案归渲染端**。原生菜单不认 i18n，所以渲染端切语言时把整份
 * 文案推过来（`set_tray_labels`），菜单点击再经事件广播回渲染端转成应用内动作。
 *
 * 「关闭到托盘」是宿主开关：点 X 时宿主读它决定隐藏还是真退。渲染端把偏好同步过来
 * （存在设置快照里），宿主只做执行。
 *
 * Linux 的坑：即便没有 StatusNotifier/AppIndicator 宿主（WSLg、裸窗口管理器都没有），
 * `new Tray()` 也**不抛错**，图标只是静默不显示 —— 于是「可用」会被误判为真，点 X 把窗口藏进
 * 一个根本看不见的托盘，再也找不回、也退不出。故以「会话总线上是否注册了
 * StatusNotifierWatcher」作为真·可用判据，探不到就判不可用，关闭行为回落「关即退」。
 */
import { execFileSync } from "node:child_process";
import { Menu, Tray, nativeImage, type BrowserWindow } from "electron";

import { IPC } from "../shared/channels";
import { trayHostPresentIn } from "../shared/tray-host";
import { sendSystemNotification } from "./notify";
import { trayIconPath } from "./paths";

/** 托盘菜单文案（宿主原生菜单不认 i18n，切语言时渲染端整份重推）。 */
export interface TrayLabels {
  toggleWindow: string;
  newChat: string;
  settings: string;
  quit: string;
  /** 首次隐藏到托盘时的一次性系统通知正文。 */
  hiddenHint: string;
}

/** 托盘回调依赖的宿主能力（窗口 / 退出）。 */
export interface TrayHost {
  window: () => BrowserWindow | null;
  quit: () => void;
  /** 窗口不存在时重建（macOS 关掉主窗后，托盘菜单仍应可用）。 */
  openWindow?: () => Promise<BrowserWindow | null>;
}

const DEFAULT_LABELS: TrayLabels = {
  toggleWindow: "Show/Hide",
  newChat: "New Conversation",
  settings: "Settings",
  quit: "Quit",
  hiddenHint: "",
};

let tray: Tray | null = null;
let available = false;
let closeToTray = false;
let labels: TrayLabels = { ...DEFAULT_LABELS };
let hiddenHintShown = false;

/** 跑一次 Linux 探针；非 Linux 直接返回 true（macOS / Windows 的托盘不需要宿主服务）。 */
function linuxTrayHostPresent(): boolean {
  if (process.platform !== "linux") return true;
  const probes: readonly (readonly [string, readonly string[]])[] = [
    ["busctl", ["--user", "list", "--no-pager"]],
    [
      "dbus-send",
      [
        "--session",
        "--dest=org.freedesktop.DBus",
        "--type=method_call",
        "--print-reply",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus.ListNames",
      ],
    ],
  ];
  const outputs: (string | null)[] = probes.map(([cmd, args]) => {
    try {
      return execFileSync(cmd, [...args], { timeout: 1000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // 工具缺失 / 调用失败：换下一个探针。
      return null;
    }
  });
  return trayHostPresentIn(outputs);
}

function currentWindow(host: TrayHost): BrowserWindow | null {
  const win = host.window();
  return win && !win.isDestroyed() ? win : null;
}

function toggleWindow(host: TrayHost): void {
  const win = currentWindow(host);
  if (!win) {
    // macOS：窗口已关但进程还在，托盘点击应把窗口建回来。
    void host.openWindow?.();
    return;
  }
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else {
    win.show();
    win.focus();
  }
}

/** 托盘菜单动作：没有窗口时先重建，再显示并执行。 */
async function withWindow(host: TrayHost, action: (win: BrowserWindow) => void): Promise<void> {
  const win = currentWindow(host) ?? (await host.openWindow?.());
  if (!win) return;
  win.show();
  win.focus();
  action(win);
}

/** 隐藏到托盘，并在首次隐藏时弹一次「仍在后台运行」系统通知。 */
export function hideToTray(host: TrayHost): void {
  currentWindow(host)?.hide();
  if (!hiddenHintShown && labels.hiddenHint) {
    sendSystemNotification("GreyWork", labels.hiddenHint, () => {
      const win = currentWindow(host);
      win?.show();
      win?.focus();
    });
    hiddenHintShown = true;
  }
}

function rebuildMenu(host: TrayHost): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: labels.toggleWindow, click: () => toggleWindow(host) },
      {
        label: labels.newChat,
        click: () => {
          void withWindow(host, (win) => win.webContents.send(IPC.tray.newChat));
        },
      },
      {
        label: labels.settings,
        click: () => {
          void withWindow(host, (win) => win.webContents.send(IPC.tray.openSettings));
        },
      },
      { type: "separator" },
      { label: labels.quit, click: () => host.quit() },
    ]),
  );
}

/** 建托盘。无宿主服务 / 创建失败 → `available` 保持 false，关闭行为回落「关即退」。 */
export function createTray(host: TrayHost): void {
  if (!linuxTrayHostPresent()) {
    available = false;
    console.info("[tray] 未检测到 StatusNotifier/AppIndicator 宿主，托盘不可用，关闭行为回落「关即退」");
    return;
  }
  try {
    const icon = nativeImage.createFromPath(trayIconPath());
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip("GreyWork");
    tray.on("click", () => toggleWindow(host));
    rebuildMenu(host);
    available = true;
  } catch (error) {
    available = false;
    console.error("[tray] 托盘不可用，关闭行为回落「关即退」：", error);
  }
}

export function isTrayAvailable(): boolean {
  return available;
}

export function isCloseToTray(): boolean {
  return closeToTray;
}

export function setCloseToTray(enabled: boolean): void {
  closeToTray = enabled;
}

/** 渲染端整份推来的菜单文案；逐字段类型校验后采用并重建菜单。 */
export function applyTrayLabels(host: TrayHost, input: unknown): void {
  if (!input || typeof input !== "object") return;
  // 文案来自渲染端 IPC，结构按约定；逐字段仍校验，缺项保留现值。
  const value = input as Record<string, unknown>;
  const str = (field: unknown, fallback: string): string => (typeof field === "string" ? field : fallback);
  labels = {
    toggleWindow: str(value.toggleWindow, labels.toggleWindow),
    newChat: str(value.newChat, labels.newChat),
    settings: str(value.settings, labels.settings),
    quit: str(value.quit, labels.quit),
    hiddenHint: str(value.hiddenHint, labels.hiddenHint),
  };
  rebuildMenu(host);
}
