/**
 * 交互式终端（真 PTY）：移植 `crates/greywork-host/src/infra/terminal/`。
 *
 * - 每个标签页一个 PTY 子进程（node-pty：Unix openpty / Windows ConPTY），支持交互输入、
 *   密码、彩色提示符、SIGWINCH 改尺寸。
 * - 输出经 `terminal://data` 广播，载荷是 **base64 原始字节**：分块可能把多字节字符切成
 *   两半，前端拿 `Uint8Array` 交给 xterm 才能正确续接。
 * - 进程退出推 `terminal://exit`；会话不因前端断连而回收（多标签、面板开合都要保活）。
 * - 全组命令属 `TRUSTED_HOST_ONLY`：PTY 是比 `shell_run` 更宽的 spawn 面，只有本机受信宿主放行。
 */
import { base64Encode } from "./base64.js";
import type { EventBus } from "./events.js";
import { detectShells, shellCatalog, type ShellOption } from "./shell-catalog.js";
import type { WorkspaceAccess } from "./workspace-access.js";
import * as pty from "node-pty";

export const DATA_EVENT = "terminal://data";
export const EXIT_EVENT = "terminal://exit";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MIN_DIM = 2;
const MAX_DIM = 1000;

export interface OpenArgs {
  sessionId?: unknown;
  cwd?: unknown;
  shell?: unknown;
  cols?: unknown;
  rows?: unknown;
}

export interface OpenResult {
  sessionId: string;
  cwd: string;
  shellId: string;
  shellLabel: string;
}

export interface LiveSession {
  sessionId: string;
  cwd: string;
  shellId: string;
  shellLabel: string;
}

interface Session {
  pty: pty.IPty;
  cwd: string;
  shellId: string;
  shellLabel: string;
  exited: boolean;
}

function clampDim(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(MAX_DIM, Math.max(MIN_DIM, parsed));
}

/** 按 id 取 shell；未知 / 缺省回落默认（与 Rust 的 `shells::resolve` 一致）。 */
function resolveShell(id: unknown): ShellOption | null {
  const shells = detectShells();
  if (shells.length === 0) return null;
  if (typeof id === "string") {
    const found = shells.find((shell) => shell.id === id);
    if (found) return found;
  }
  const catalog = shellCatalog();
  return shells.find((shell) => shell.id === catalog.defaultId) ?? shells[0];
}

export class TerminalHost {
  private readonly sessions = new Map<string, Session>();
  private seq = 0;

  constructor(
    private readonly bus: EventBus,
    private readonly access: WorkspaceAccess,
  ) {}

  catalog() {
    return shellCatalog();
  }

  /** 列出仍在跑的会话（顺带回收已退出但没 close 的）。 */
  list(): LiveSession[] {
    for (const [id, session] of this.sessions) {
      if (session.exited) {
        try {
          session.pty.kill();
        } catch {
          // 已经退出。
        }
        this.sessions.delete(id);
      }
    }
    return [...this.sessions.entries()]
      .map(([sessionId, session]) => ({
        sessionId,
        cwd: session.cwd,
        shellId: session.shellId,
        shellLabel: session.shellLabel,
      }))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  open(args: OpenArgs): OpenResult {
    const rawCwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
    const cwd = rawCwd === "" ? this.access.root : this.access.resolveExisting(rawCwd);
    const shell = resolveShell(args.shell);
    if (!shell) throw new Error("本机没有可用的 shell");

    const cols = clampDim(args.cols, DEFAULT_COLS);
    const rows = clampDim(args.rows, DEFAULT_ROWS);
    const requestedId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    if (requestedId !== "" && this.sessions.has(requestedId)) {
      throw new Error(`会话 id 已存在: ${requestedId}`);
    }
    const sessionId = requestedId !== "" ? requestedId : `term-${process.pid}-${this.seq++}`;

    const child = pty.spawn(shell.program, shell.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      // null = 不做 UTF-8 解码，直接拿原始字节：分块可能切断多字节字符，
      // 交给前端 xterm 的 Uint8Array 续接才对。
      encoding: null,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      } as Record<string, string>,
    });

    const session: Session = { pty: child, cwd, shellId: shell.id, shellLabel: shell.label, exited: false };
    this.sessions.set(sessionId, session);

    child.onData((data: string | Buffer) => {
      this.bus.broadcast(DATA_EVENT, { sessionId, data: base64Encode(data) });
    });
    child.onExit(() => {
      session.exited = true;
      this.bus.broadcast(EXIT_EVENT, { sessionId });
    });

    return { sessionId, cwd, shellId: shell.id, shellLabel: shell.label };
  }

  /** 键盘输入（含转义序列）；会话已退出时静默成功（与 Rust 一致）。 */
  write(sessionId: string, data: string): void {
    const session = this.require(sessionId);
    if (session.exited) return;
    session.pty.write(data);
  }

  resize(sessionId: string, cols: unknown, rows: unknown): void {
    const session = this.require(sessionId);
    if (session.exited) return;
    session.pty.resize(clampDim(cols, DEFAULT_COLS), clampDim(rows, DEFAULT_ROWS));
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.exited = true;
    try {
      session.pty.kill();
    } catch {
      // 已经退出。
    }
    this.sessions.delete(sessionId);
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  private require(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`终端会话不存在: ${sessionId}`);
    return session;
  }
}
