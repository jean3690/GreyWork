/**
 * 终端命令运行器：把一条用户命令交给登录 shell 跑完，回收合并后的输出。
 *
 * 安全边界：`shell_run` 属 `TRUSTED_HOST_ONLY`（见 policy.rs），只有本机受信宿主才放行。
 * 非交互：stdin 接空设备、有超时与输出上限。交互式 TUI（vim / top）得用 PTY（`terminal_open`）。
 */
import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 256 * 1024;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 900_000;

export interface ShellRunResult {
  output: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
}

export async function shellRun(command: string, cwd: string, timeoutMs: number): Promise<ShellRunResult> {
  const clampedTimeout = Math.min(Math.max(timeoutMs, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const shell = process.platform === "win32" ? "cmd" : "sh";
  const shellArgs = process.platform === "win32" ? ["/C", command] : ["-c", command];

  return new Promise((resolve) => {
    const started = Date.now();
    const proc = spawn(shell, shellArgs, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const chunks: Buffer[] = [];
    let truncated = false;
    let timedOut = false;

    const collect = (chunk: Buffer) => {
      if (chunks.reduce((acc, c) => acc + c.length, 0) >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      chunks.push(chunk);
    };
    proc.stdout?.on("data", collect);
    proc.stderr?.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") proc.kill();
        else process.kill(-proc.pid!, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    }, clampedTimeout);

    proc.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        output: Buffer.concat(chunks).toString("utf8"),
        exitCode: timedOut ? null : code,
        durationMs: Date.now() - started,
        truncated,
        timedOut,
      });
    });
  });
}
