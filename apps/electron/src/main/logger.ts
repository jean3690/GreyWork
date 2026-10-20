/**
 * 主进程日志落盘。
 *
 * 打包态没有终端：sidecar 起不来、自动登录失败、渲染进程崩溃这些现场只留在
 * `console.*` 里，用户报障时拿不到任何东西。这里把 `console` 三路输出同时追加到
 * `<userData>/logs/main.log`，超过 5 MiB 轮转一份（只留一代，避免无限增长）。
 *
 * 写日志本身失败必须静默：日志是旁路，不能反过来影响启动。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { app } from "electron";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

let logFile: string | null = null;

/** 文件超过上限时把当前日志挪到 `.1`（覆盖上一代）。 */
function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file) || statSync(file).size <= MAX_LOG_BYTES) return;
    const previous = `${file}.1`;
    if (existsSync(previous)) unlinkSync(previous);
    renameSync(file, previous);
  } catch {
    // 轮转失败就继续写同一个文件。
  }
}

function write(level: string, args: readonly unknown[]): void {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `[${new Date().toISOString()}] [${level}] ${format(...args)}\n`, "utf8");
  } catch {
    // 磁盘满 / 权限问题：丢弃这一行。
  }
}

/** 安装文件日志；必须在 `app.whenReady()` 之后调用（userData 路径此时才确定）。 */
export function installFileLogging(): void {
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "main.log");
    rotateIfNeeded(file);
    logFile = file;

    const originals = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args: unknown[]) => {
      originals.log(...args);
      write("info", args);
    };
    console.warn = (...args: unknown[]) => {
      originals.warn(...args);
      write("warn", args);
    };
    console.error = (...args: unknown[]) => {
      originals.error(...args);
      write("error", args);
    };

    process.on("uncaughtException", (error) => {
      console.error("[main] uncaughtException", error);
    });
    process.on("unhandledRejection", (reason) => {
      console.error("[main] unhandledRejection", reason);
    });

    console.log(
      `[main] 日志落盘：${file}（GreyWork ${app.getVersion()} / Electron ${process.versions.electron} / ${process.platform}）`,
    );
  } catch (error) {
    // 无法建目录：保持原样，只打终端。
    console.warn("[main] 文件日志不可用：", error);
  }
}
