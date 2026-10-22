/**
 * 登录 shell PATH 的解析与缓存。
 *
 * 为什么需要：从桌面图标启动时，GUI 会话继承的 PATH 常被截断，不含 `~/.local/bin`、
 * nvm / npm 全局、`~/.cargo/bin` 等 —— 于是 sidecar 的 agent CLI 探测找不到 claude /
 * gemini，表现为「agent 列表为空」。
 *
 * 为什么缓存：解析要走一次登录 shell（`bash -lc`），而 `.bashrc` / `.zshrc` 里的 nvm、
 * conda 等初始化可能耗时几十到几百毫秒。把它放在「起 sidecar 之前」的同步路径上，等于
 * 每次启动都白等一遍。这里把结果落盘（24h 有效），**本次启动立即用缓存**，过期后在后台
 * 异步刷新，下次启动生效；首次启动才同步探测一次，并设 1.5s 上限。
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

import { mergePathEntries } from "../shared/shell-path";

/** 缓存有效期：一天。过期后仍先用旧值启动，再在后台刷新。 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 首次启动同步探测的上限：超过就先用继承的 PATH，绝不把启动拖到秒级。 */
const FIRST_PROBE_TIMEOUT_MS = 1500;
/** 后台刷新的上限：不占关键路径，给足时间让 conda / nvm 初始化。 */
const REFRESH_TIMEOUT_MS = 3000;

interface ShellPathCache {
  /** 登录 shell 输出的原始 PATH；使用时再与当前进程 PATH 合并。 */
  readonly shellPath: string;
  readonly resolvedAt: number;
}

const cacheFile = (): string => path.join(app.getPath("userData"), "shell-path.json");

function readCache(): ShellPathCache | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cacheFile(), "utf8"));
    if (parsed && typeof parsed === "object") {
      const { shellPath, resolvedAt } = parsed as Record<string, unknown>;
      if (typeof shellPath === "string" && shellPath && typeof resolvedAt === "number" && Number.isFinite(resolvedAt)) {
        return { shellPath, resolvedAt };
      }
    }
  } catch {
    // 首次启动无文件 / 文件损坏：走同步探测。
  }
  return null;
}

function persistCache(shellPath: string): void {
  try {
    writeFileSync(cacheFile(), JSON.stringify({ shellPath, resolvedAt: Date.now() }), { mode: 0o600 });
  } catch (error) {
    // 写失败只影响下次启动（会重新探测），不影响本次。
    console.warn("[shell-path] 缓存落盘失败（下次启动重新探测）：", error);
  }
}

/** 常见用户 bin 目录：登录 shell 也拿不到时的兜底。 */
function commonEntries(home: string): string[] {
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".bun", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
}

function compose(shellPath: string | null, base: string, home: string): string {
  return mergePathEntries([shellPath ?? "", base, ...commonEntries(home)], path.delimiter);
}

/**
 * 跑一次登录 shell 取 PATH。返回最后一行非空输出（跳过 .bashrc 里的 banner）。
 * 失败 / 超时 / 空输出都返回 null，由调用方回落到继承的 PATH。
 */
function probeShell(shell: string, timeoutMs: number): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  execFile(
    shell,
    ["-lc", 'printf %s "$PATH"'],
    { timeout: timeoutMs, encoding: "utf8", windowsHide: true },
    (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      resolve(lines.at(-1) ?? null);
    },
  );
  return promise;
}

let refreshing: Promise<void> | null = null;

/** 后台刷新缓存；同一时刻只跑一次。 */
function refreshInBackground(shell: string): void {
  if (refreshing) return;
  refreshing = probeShell(shell, REFRESH_TIMEOUT_MS)
    .then((shellPath) => {
      if (shellPath) persistCache(shellPath);
    })
    .catch(() => {
      // 后台刷新失败：保留旧缓存，下次再试。
    })
    .finally(() => {
      refreshing = null;
    });
}

/**
 * 解析 sidecar / dev server 可见的 PATH。
 *
 * Windows 上登录 shell 的语义不同（`SHELL` 通常不存在），沿用继承的 PATH。
 */
export async function resolveUserShellPath(base: string): Promise<string> {
  if (process.platform === "win32") return base;

  const home = app.getPath("home");
  const shell = process.env.SHELL;
  const cached = readCache();

  if (cached) {
    if (shell && Date.now() - cached.resolvedAt > CACHE_TTL_MS) refreshInBackground(shell);
    return compose(cached.shellPath, base, home);
  }

  if (!shell) return compose(null, base, home);

  const probed = await probeShell(shell, FIRST_PROBE_TIMEOUT_MS);
  if (probed) persistCache(probed);
  return compose(probed, base, home);
}
