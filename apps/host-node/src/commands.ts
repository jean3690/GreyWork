/**
 * 命令面：元数据来自 Rust 侧导出的快照（`command-manifest.json`），实现按领域逐步迁移。
 *
 * **契约以 Rust 为真源**：命令名、auth、desktopOnly、binary 由
 * `crates/greywork-host/examples/dump_commands.rs` 导出，Node 侧不手抄；
 * 快照过期时跑 `pnpm --filter @greywork/host-node manifest` 重新生成。
 *
 * P0 只迁了 `store_default_root` 这一条叶子命令，用来打通「HTTP → 分发 → 返回 JSON」的管线。
 * 未迁移的命令在 `/api/commands` 里标 `available: false`，前端据此灰显，避免「点了才报错」。
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import manifest from "./command-manifest.json" with { type: "json" };

export interface CommandMeta {
  name: string;
  auth: "required" | "none";
  desktopOnly: boolean;
  binary: boolean;
}

export interface CommandView extends CommandMeta {
  /** 在本宿主是否可调用：非桌面专属 **且** 已迁移到 Node。 */
  available: boolean;
}

export const COMMANDS: readonly CommandMeta[] = manifest as CommandMeta[];

/** 已迁移命令的实现表。键必须是 manifest 里存在的名字（有单测兜住）。 */
const HANDLERS = new Map<string, (args: unknown) => Promise<unknown>>();

/** `~/.greyWork`：与 Rust `store_fs::store_default_root` 同语义（含自动创建）。 */
function storeDefaultRoot(): string {
  const root = path.join(homedir(), ".greyWork");
  mkdirSync(root, { recursive: true });
  // Windows 的 \\?\ 前缀不跨进程稳定，与 Rust 侧 strip_verbatim_prefix 一致地去掉。
  return process.platform === "win32" ? root.replace(/^\\\\\?\\/, "") : root;
}

HANDLERS.set("store_default_root", async () => storeDefaultRoot());

export function isMigrated(name: string): boolean {
  return HANDLERS.has(name);
}

export function listCommands(): CommandView[] {
  return COMMANDS.map((meta) => ({
    ...meta,
    available: !meta.desktopOnly && isMigrated(meta.name),
  }));
}

export class CommandError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function dispatch(name: unknown, args: unknown): Promise<unknown> {
  if (typeof name !== "string" || name === "") {
    throw new CommandError(400, "缺少命令名");
  }
  const meta = COMMANDS.find((item) => item.name === name);
  if (!meta) {
    // 与 Rust 的 `未知命令: {name}` 同一信封与状态码（400）。
    throw new CommandError(400, `未知命令: ${name}`);
  }
  if (meta.desktopOnly) {
    throw new CommandError(403, `命令 ${name} 仅桌面端可用`);
  }
  const handler = HANDLERS.get(name);
  if (!handler) {
    // 迁移期的明确信号：不是「命令不存在」，而是「这条还没搬过来」。
    throw new CommandError(501, `命令 ${name} 尚未迁移到 Node 宿主`);
  }
  return handler(args);
}
