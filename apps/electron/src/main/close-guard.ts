/**
 * 关闭—退出守卫的主进程状态（对齐 Tauri 壳的 `close_guard.rs`）。
 *
 * 脏不脏只有渲染端知道，所以分工是：主进程拦住「点 X」，把决定权交给渲染端；渲染端决定收口
 * （自动保存后真关、或弹确认），再回调 `requestClose()` 让主进程执行。
 *
 * 三个状态位：
 * - `unsaved`：渲染端经 `syncUnsavedChanges` 同步的「有未保存改动」标记；
 * - `released`：守卫已放行（渲染端确认 / 兜底超时 / 应用正在退出）—— 此后 close 不再拦；
 * - `fallback`：把关闭交给渲染端时起的 2s 定时器，防渲染端没接线导致窗口永远关不掉。
 */
import type { BrowserWindow } from "electron";

import { IPC } from "../shared/channels";

let unsaved = false;
let released = false;
let fallback: NodeJS.Timeout | undefined;

/** 渲染端同步来的未保存标记。 */
export function setUnsaved(value: boolean): void {
  unsaved = value;
}

/** 点 X 时是否该拦下来交渲染端决定。 */
export function shouldInterceptClose(): boolean {
  return unsaved && !released;
}

/**
 * 退出路径（Cmd+Q / 托盘「退出」/ 系统注销）该不该拦。
 *
 * 有未保存改动、守卫尚未放行、且窗口还在 —— 三条缺一不可。窗口已销毁时弹不出确认层，
 * 再拦只会把应用卡在「退不掉又没法问」的死局里。
 */
export function exitShouldBlock(unsavedFlag: boolean, releasedFlag: boolean, hasWindow: boolean): boolean {
  return unsavedFlag && !releasedFlag && hasWindow;
}

/** 当前退出路径是否该拦（读模块状态，供 `before-quit` 使用）。 */
export function shouldInterceptExit(hasWindow: boolean): boolean {
  return exitShouldBlock(unsaved, released, hasWindow);
}

/**
 * 把退出决定权交给渲染端（`onExitRequested` → 保存 / 确认 → `confirmExit`）。
 *
 * 与点 X 不同，这条路径没有兜底超时：渲染端可能正在展示保存确认，强制超时会丢数据。
 */
export function handExitToRenderer(win: BrowserWindow): void {
  win.webContents.send(IPC.closeGuard.exitRequested);
}

export function isReleased(): boolean {
  return released;
}

/** 放行关闭，并清掉兜底定时器。 */
export function release(): void {
  released = true;
  clearTimeout(fallback);
  fallback = undefined;
}

/** 把关闭决定权交给渲染端；同时起兜底定时器，超时后强制放行。 */
export function handCloseToRenderer(win: BrowserWindow, onTimeout: () => void): void {
  win.webContents.send(IPC.closeGuard.closeRequested);
  clearTimeout(fallback);
  fallback = setTimeout(() => {
    console.warn("[close-guard] 渲染端未在 2s 内回应关闭请求，强制关闭");
    release();
    onTimeout();
  }, 2000);
}
