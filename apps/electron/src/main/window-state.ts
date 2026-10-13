/**
 * 窗口几何持久化（对应 Tauri 的 `tauri-plugin-window-state`）。
 *
 * 只记「正常态」的 x/y/宽高与是否最大化 —— **刻意不记 visible**：窗口何时显示由主进程
 * `ready-to-show` 控制（防白屏），记了可见性反而会出现「上次异常退出 → 这次起来就不显示」。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, type BrowserWindow } from "electron";

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const DEFAULT_STATE: WindowState = { width: 1280, height: 820, maximized: false };
const stateFile = (): string => path.join(app.getPath("userData"), "window-state.json");
let saveTimer: NodeJS.Timeout | undefined;

export function loadWindowState(): WindowState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile(), "utf8"));
    if (parsed && typeof parsed === "object") {
      // 本地状态文件由本进程写入、结构可信；逐字段仍做类型校验后才采用。
      const obj = parsed as Record<string, unknown>;
      return {
        x: typeof obj.x === "number" ? obj.x : undefined,
        y: typeof obj.y === "number" ? obj.y : undefined,
        width: typeof obj.width === "number" ? obj.width : DEFAULT_STATE.width,
        height: typeof obj.height === "number" ? obj.height : DEFAULT_STATE.height,
        maximized: obj.maximized === true,
      };
    }
  } catch {
    // 首启无文件 / 解析失败：用默认尺寸。
  }
  return { ...DEFAULT_STATE };
}

export function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const { x, y, width, height } = win.getNormalBounds();
  const state: WindowState = { x, y, width, height, maximized: win.isMaximized() };
  try {
    writeFileSync(stateFile(), JSON.stringify(state));
  } catch {
    // 落盘失败不影响运行。
  }
}

/** 拖拽 / 缩放期间高频触发：去抖 400ms 再写盘。 */
export function scheduleSaveWindowState(win: BrowserWindow): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveWindowState(win), 400);
}
