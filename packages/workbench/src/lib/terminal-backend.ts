/**
 * 交互式终端的宿主通道（Rust `terminal_*` 命令 + `terminal://data` 事件）。
 *
 * 这是**真 PTY**：`terminal_open` 起一个 shell 子进程，输出经 `terminal://data` 事件
 * 流式下发（base64 字节，前端解成 `Uint8Array` 交给 xterm），键盘输入经 `terminal_write`
 * 回写。所以 `vim` / `top` / 密码输入 / 彩色提示符都能用，与电脑上的终端一致。
 *
 * 一组 `terminal_*` 在服务端策略里属 `TRUSTED_HOST_ONLY`：只有「客户端与服务端同机且
 * 受信」（Electron 壳 / 本地宿主）才放行，网络暴露的自托管会被 403。浏览器预览态没有宿主，
 * 调用方据 `supported()` 自行降级。
 */
import { hasHostCommands, invoke } from "@greywork/host-ipc";

/** 一个可选终端环境（`terminal_shells` 的条目）。 */
export interface ShellInfo {
  /** 稳定标识，`terminal_open` 按它选 shell。 */
  id: string;
  /** 展示名。 */
  label: string;
}

/** `terminal_shells` 的返回。 */
export interface ShellCatalog {
  shells: ShellInfo[];
  /** 默认 shell（新建标签页预选）；本机一个都探测不到时为 null。 */
  defaultId: string | null;
}

export interface TerminalOpenOptions {
  /**
   * 会话 id：调用方先生成、**先订阅 `terminal://data` 再带着它来开**。
   * 否则 shell 已回显的首屏提示符可能在订阅生效前发出而丢掉。
   */
  sessionId: string;
  /** 工作目录；必须是已授权的既有路径。缺省用宿主默认根。 */
  cwd?: string;
  /** shell id；缺省 / 未知用默认 shell。 */
  shell?: string;
  cols: number;
  rows: number;
}

/** `terminal_open` 的返回。 */
export interface TerminalOpenResult {
  sessionId: string;
  /** 实际落点的工作目录。 */
  cwd: string;
  shellId: string;
  shellLabel: string;
}

export const terminalBackend = {
  /** 是否有宿主可跑终端：桌面端与服务端为真，浏览器预览态为假。 */
  supported: (): boolean => hasHostCommands(),

  /** 本机可用的终端环境。 */
  shells: (): Promise<ShellCatalog> => invoke<ShellCatalog>("terminal_shells"),

  /** 开一个新会话（起 PTY + shell）。 */
  open: (options: TerminalOpenOptions): Promise<TerminalOpenResult> =>
    invoke<TerminalOpenResult>("terminal_open", {
      sessionId: options.sessionId,
      cwd: options.cwd ?? null,
      shell: options.shell ?? null,
      cols: options.cols,
      rows: options.rows,
    }),

  /** 键盘输入（含转义序列）写进会话。 */
  write: (sessionId: string, data: string): Promise<void> => invoke<void>("terminal_write", { sessionId, data }),

  /** 通知内核新窗口尺寸（子进程收到 SIGWINCH）。 */
  resize: (sessionId: string, cols: number, rows: number): Promise<void> => invoke<void>("terminal_resize", { sessionId, cols, rows }),

  /** 关掉会话（杀子进程）。 */
  close: (sessionId: string): Promise<void> => invoke<void>("terminal_close", { sessionId }),
};
