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
import manifest from "./command-manifest.json" with { type: "json" };

import { shellCatalog } from "./shell-catalog.js";
import type { Db } from "./db.js";
import type { WorkspaceAccess } from "./workspace-access.js";

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

/**
 * 可信宿主才放行的命令（与 apps/server/src/policy.rs 的 `TRUSTED_HOST_ONLY` 同名单）。
 * 这些是「只要能开终端就等于拿到本机任意代码执行」的面，网络暴露部署必须关掉。
 */
const TRUSTED_HOST_ONLY = new Set([
  "db_agents_sync",
  "fs_authorize_drop_paths",
  "fs_authorize_picked_paths",
  "shell_run",
  "terminal_close",
  "terminal_list",
  "terminal_open",
  "terminal_resize",
  "terminal_shells",
  "terminal_write",
]);

export function isDenied(name: string, trustedHost: boolean): boolean {
  return !trustedHost && TRUSTED_HOST_ONLY.has(name);
}

/** 命令实现拿到的宿主上下文（只放已迁移能力，避免半迁移状态下出现半初始化的对象）。 */
export interface CommandContext {
  access: WorkspaceAccess;
  db: Db;
  trustedHost: boolean;
}

type Handler = (args: unknown, ctx: CommandContext) => Promise<unknown>;

/** 已迁移命令的实现表。键必须是 manifest 里存在的名字（有单测兜住）。 */
const HANDLERS = new Map<string, Handler>();

/** 读入参里的 path：与 Rust 的 `PathArg` 同口径（缺字段直接报错，不做兜底）。 */
function pathArg(args: unknown): string {
  const value = (args as { path?: unknown } | null)?.path;
  if (typeof value !== "string" || value === "") {
    throw new CommandError(400, "缺少参数 path");
  }
  return value;
}

HANDLERS.set("store_default_root", async (_args, ctx) => ctx.access.root);
HANDLERS.set("terminal_shells", async () => shellCatalog());
HANDLERS.set("fs_list_dir", async (args, ctx) => ctx.access.listDir(pathArg(args)));
HANDLERS.set("fs_read_text_file", async (args, ctx) => ctx.access.readTextFile(pathArg(args)));
HANDLERS.set("fs_write_text_file", async (args, ctx) => {
  const content = (args as { content?: unknown } | null)?.content;
  if (typeof content !== "string") throw new CommandError(400, "缺少参数 content");
  ctx.access.writeTextFile(pathArg(args), content);
  return null;
});
HANDLERS.set("fs_ensure_dir", async (args, ctx) => {
  ctx.access.ensureDir(pathArg(args));
  return null;
});
HANDLERS.set("fs_create_file", async (args, ctx) => {
  ctx.access.createFile(pathArg(args));
  return null;
});
HANDLERS.set("fs_create_dir", async (args, ctx) => {
  ctx.access.createDir(pathArg(args));
  return null;
});
HANDLERS.set("db_settings_load", async (_args, ctx) => ctx.db.loadSettings());
HANDLERS.set("db_settings_sync", async (args, ctx) => {
  const settings = (args as { settings?: unknown } | null)?.settings;
  if (settings === undefined) throw new CommandError(400, "缺少参数 settings");
  ctx.db.syncSettings(settings);
  return null;
});

export function isMigrated(name: string): boolean {
  return HANDLERS.has(name);
}

export function listCommands(trustedHost: boolean): CommandView[] {
  return COMMANDS.map((meta) => ({
    ...meta,
    available: !meta.desktopOnly && !isDenied(meta.name, trustedHost) && isMigrated(meta.name),
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

export async function dispatch(name: unknown, args: unknown, ctx: CommandContext): Promise<unknown> {
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
  if (isDenied(name, ctx.trustedHost)) {
    throw new CommandError(403, `命令 ${name} 需要可信宿主（本机桌面端）`);
  }
  const handler = HANDLERS.get(name);
  if (!handler) {
    // 迁移期的明确信号：不是「命令不存在」，而是「这条还没搬过来」。
    throw new CommandError(501, `命令 ${name} 尚未迁移到 Node 宿主`);
  }
  try {
    return await handler(args, ctx);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    // 与 Rust 的 dispatch 同口径：命令实现失败一律 400 + 原文（前端直接展示这句）。
    throw new CommandError(400, error instanceof Error ? error.message : String(error));
  }
}
