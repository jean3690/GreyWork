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
import { detectPrograms } from "./acp-probe.js";
import { skillsInstall, skillsUninstall } from "./skills.js";
import { fetchPage } from "./web-fetch.js";
import { checkUpdate } from "./update.js";
import type { AgentProvider, AutomationRunInput, AutomationTask, Db, TeamRun } from "./db.js";
import { gitChanges, gitCurrentBranch, gitDiff, gitStatus, runGit } from "./git.js";
import { ragIndexBuild, ragSearch } from "./rag.js";
import { listWorktrees, releaseWorktree } from "./worktree.js";
import { chatComplete, embed, listModels, transcribe, type LlmChatMessage, type LlmStreamHost } from "./llm.js";
import type { EventBus } from "./events.js";
import type { SessionFileStore, WorkspaceDir } from "./session-store.js";
import type { RagIndexHost } from "./rag.js";
import type { TerminalHost } from "./terminal.js";
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
  bus: EventBus;
  db: Db;
  rag: RagIndexHost;
  store: SessionFileStore;
  llm: LlmStreamHost;
  terminal: TerminalHost;
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
HANDLERS.set("fs_read_binary", async (args, ctx) => new BinaryOutput(ctx.access.readBinary(pathArg(args))));
HANDLERS.set("fs_probe_file", async (args, ctx) => ctx.access.probeFile(pathArg(args)));
HANDLERS.set("fs_read_media", async (args, ctx) => {
  const maxBytes = (args as { maxBytes?: unknown } | null)?.maxBytes;
  return new BinaryOutput(ctx.access.readMedia(pathArg(args), maxBytes));
});
HANDLERS.set("fs_write_binary", async (args, ctx) => {
  const data = (args as { dataBase64?: unknown } | null)?.dataBase64;
  if (typeof data !== "string") throw new CommandError(400, "缺少参数 dataBase64");
  ctx.access.writeBinary(pathArg(args), data);
  return null;
});
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
HANDLERS.set("fs_delete_path", async (args, ctx) => {
  ctx.access.deletePath(pathArg(args));
  return null;
});
/** 改名 / 复制共用入参：`{ from, to }`，两边都必须是字符串。 */
function transferArgs(args: unknown): { from: string; to: string } {
  const value = args as { from?: unknown; to?: unknown } | null;
  if (typeof value?.from !== "string" || typeof value?.to !== "string") {
    throw new CommandError(400, "缺少参数 from / to");
  }
  return { from: value.from, to: value.to };
}
HANDLERS.set("fs_rename_path", async (args, ctx) => {
  const { from, to } = transferArgs(args);
  ctx.access.renamePath(from, to);
  return null;
});
HANDLERS.set("fs_copy_path", async (args, ctx) => {
  const { from, to } = transferArgs(args);
  ctx.access.copyPath(from, to);
  return null;
});
/** git 入参：`{ root }`（授权根内的目录）。 */
function rootArg(args: unknown): string {
  const value = (args as { root?: unknown } | null)?.root;
  if (typeof value !== "string" || value === "") {
    throw new CommandError(400, "缺少参数 root");
  }
  return value;
}

HANDLERS.set("git_status", async (args, ctx) => gitStatus(ctx.access, rootArg(args)));
HANDLERS.set("git_changes", async (args, ctx) => gitChanges(ctx.access, rootArg(args)));
HANDLERS.set("git_diff", async (args, ctx) => {
  const value = args as { root?: unknown; path?: unknown; staged?: unknown } | null;
  const root = rootArg(args);
  const filePath = typeof value?.path === "string" && value.path !== "" ? value.path : null;
  return gitDiff(ctx.access, root, filePath, value?.staged === true);
});
HANDLERS.set("git_current_branch", async (args, ctx) => gitCurrentBranch(ctx.access, rootArg(args)));

HANDLERS.set("terminal_list", async (_args, ctx) => ctx.terminal.list());
HANDLERS.set("terminal_open", async (args, ctx) => ctx.terminal.open((args ?? {}) as never));
HANDLERS.set("terminal_write", async (args, ctx) => {
  const value = args as { sessionId?: unknown; data?: unknown } | null;
  if (typeof value?.sessionId !== "string" || typeof value?.data !== "string") {
    throw new CommandError(400, "缺少参数 sessionId / data");
  }
  ctx.terminal.write(value.sessionId, value.data);
  return null;
});
HANDLERS.set("terminal_resize", async (args, ctx) => {
  const value = args as { sessionId?: unknown; cols?: unknown; rows?: unknown } | null;
  if (typeof value?.sessionId !== "string") throw new CommandError(400, "缺少参数 sessionId");
  ctx.terminal.resize(value.sessionId, value.cols, value.rows);
  return null;
});
HANDLERS.set("terminal_close", async (args, ctx) => {
  const value = args as { sessionId?: unknown } | null;
  if (typeof value?.sessionId !== "string") throw new CommandError(400, "缺少参数 sessionId");
  ctx.terminal.close(value.sessionId);
  return null;
});

HANDLERS.set("rag_index_build", async (args, ctx) => {
  const value = args as {
    root?: unknown;
    baseUrl?: unknown;
    model?: unknown;
    apiKeyEnv?: unknown;
    headers?: unknown;
    force?: unknown;
  } | null;
  if (typeof value?.root !== "string" || typeof value?.baseUrl !== "string" || typeof value?.model !== "string") {
    throw new CommandError(400, "缺少参数 root / baseUrl / model");
  }
  return ragIndexBuild(ctx.bus, ctx.access, ctx.db, ctx.rag, {
    root: value.root,
    baseUrl: value.baseUrl,
    model: value.model,
    apiKeyEnv: typeof value.apiKeyEnv === "string" ? value.apiKeyEnv : null,
    headers: (value.headers ?? undefined) as Record<string, string> | undefined,
    force: value.force === true,
  });
});
HANDLERS.set("rag_search", async (args, ctx) => {
  const value = args as {
    query?: unknown;
    baseUrl?: unknown;
    model?: unknown;
    apiKeyEnv?: unknown;
    headers?: unknown;
    topK?: unknown;
  } | null;
  if (typeof value?.query !== "string" || typeof value?.baseUrl !== "string" || typeof value?.model !== "string") {
    throw new CommandError(400, "缺少参数 query / baseUrl / model");
  }
  return ragSearch(ctx.rag, {
    query: value.query,
    baseUrl: value.baseUrl,
    model: value.model,
    apiKeyEnv: typeof value.apiKeyEnv === "string" ? value.apiKeyEnv : null,
    headers: (value.headers ?? undefined) as Record<string, string> | undefined,
    topK: value.topK,
  });
});

HANDLERS.set("rag_status", async (_args, ctx) => {
  const stats = ctx.db.ragStats();
  const model = ctx.db.ragMetaGet("rag.embedding.model");
  const dimRaw = ctx.db.ragMetaGet("rag.embedding.dim");
  const dim = dimRaw !== null && /^\d+$/.test(dimRaw) ? Number(dimRaw) : null;
  return { chunks: stats.chunks, files: stats.files, model, dim };
});
HANDLERS.set("rag_clear", async (_args, ctx) => {
  ctx.db.ragClear();
  return null;
});

HANDLERS.set("worktree_list", async (_args, ctx) => listWorktrees(ctx.access));
HANDLERS.set("worktree_release", async (args, ctx) => {
  const root = (args as { root?: unknown } | null)?.root;
  if (typeof root !== "string") throw new CommandError(400, "缺少参数 root");
  await releaseWorktree(ctx.access, root, runGit);
  return null;
});
HANDLERS.set("skills_install", async (args) => {
  const value = args as { workspaceRoot?: unknown; skillId?: unknown; files?: unknown } | null;
  if (typeof value?.workspaceRoot !== "string" || typeof value?.skillId !== "string" || !Array.isArray(value.files)) {
    throw new CommandError(400, "缺少参数 workspaceRoot / skillId / files");
  }
  return skillsInstall(value.workspaceRoot, value.skillId, value.files as { path: string; contents: string }[]);
});
HANDLERS.set("skills_uninstall", async (args) => {
  const value = args as { workspaceRoot?: unknown; skillId?: unknown } | null;
  if (typeof value?.workspaceRoot !== "string" || typeof value?.skillId !== "string") {
    throw new CommandError(400, "缺少参数 workspaceRoot / skillId");
  }
  skillsUninstall(value.workspaceRoot, value.skillId);
  return null;
});

HANDLERS.set("web_fetch", async (args) => {
  const url = (args as { url?: unknown } | null)?.url;
  if (typeof url !== "string") throw new CommandError(400, "缺少参数 url");
  return fetchPage(url);
});

HANDLERS.set("check_update", async () => checkUpdate());

HANDLERS.set("llm_chat_start", async (args, ctx) => {
  const value = args as {
    baseUrl?: unknown;
    model?: unknown;
    apiKeyEnv?: unknown;
    messages?: unknown;
    reasoningEffort?: unknown;
    headers?: unknown;
    temperature?: unknown;
    maxTokens?: unknown;
    clientToken?: unknown;
  } | null;
  if (typeof value?.baseUrl !== "string" || typeof value?.model !== "string" || !Array.isArray(value.messages)) {
    throw new CommandError(400, "缺少参数 baseUrl / model / messages");
  }
  return ctx.llm.start({
    baseUrl: value.baseUrl,
    model: value.model,
    apiKeyEnv: typeof value.apiKeyEnv === "string" ? value.apiKeyEnv : null,
    messages: value.messages as LlmChatMessage[],
    reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort : "",
    headers: (value.headers ?? undefined) as Record<string, string> | undefined,
    temperature: typeof value.temperature === "number" ? value.temperature : null,
    maxTokens: typeof value.maxTokens === "number" ? value.maxTokens : null,
    clientToken: typeof value.clientToken === "string" ? value.clientToken : null,
  });
});
HANDLERS.set("llm_chat_stop", async (args, ctx) => {
  const requestId = (args as { requestId?: unknown } | null)?.requestId;
  if (typeof requestId !== "number") throw new CommandError(400, "缺少参数 requestId");
  return ctx.llm.stop(requestId);
});

HANDLERS.set("llm_list_models", async (args) => {
  const value = args as { baseUrl?: unknown; apiKeyEnv?: unknown; headers?: unknown } | null;
  if (typeof value?.baseUrl !== "string") throw new CommandError(400, "缺少参数 baseUrl");
  return listModels({
    baseUrl: value.baseUrl,
    apiKeyEnv: typeof value.apiKeyEnv === "string" ? value.apiKeyEnv : null,
    headers: (value.headers ?? undefined) as Record<string, string> | undefined,
  });
});
HANDLERS.set("llm_embed", async (args) => {
  const value = args as {
    baseUrl?: unknown;
    model?: unknown;
    apiKeyEnv?: unknown;
    headers?: unknown;
    input?: unknown;
  } | null;
  if (typeof value?.baseUrl !== "string" || typeof value?.model !== "string") {
    throw new CommandError(400, "缺少参数 baseUrl / model");
  }
  return embed({
    baseUrl: value.baseUrl,
    model: value.model,
    apiKeyEnv: typeof value.apiKeyEnv === "string" ? value.apiKeyEnv : null,
    headers: (value.headers ?? undefined) as Record<string, string> | undefined,
    input: Array.isArray(value.input) ? (value.input as string[]) : [],
  });
});
HANDLERS.set("llm_chat_complete", async (args) => {
  const value = args as {
    baseUrl?: unknown;
    model?: unknown;
    apiKeyEnv?: unknown;
    messages?: unknown;
    reasoningEffort?: unknown;
    headers?: unknown;
  } | null;
  if (typeof value?.baseUrl !== "string" || typeof value?.model !== "string" || !Array.isArray(value.messages)) {
    throw new CommandError(400, "缺少参数 baseUrl / model / messages");
  }
  return chatComplete({
    baseUrl: value.baseUrl,
    model: value.model,
    apiKeyEnv: typeof value.apiKeyEnv === "string" ? value.apiKeyEnv : null,
    messages: value.messages as LlmChatMessage[],
    reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort : "",
    headers: (value.headers ?? undefined) as Record<string, string> | undefined,
  });
});
HANDLERS.set("llm_transcribe", async (args, ctx) => {
  const value = args as {
    baseUrl?: unknown;
    model?: unknown;
    apiKeyEnv?: unknown;
    headers?: unknown;
    path?: unknown;
    language?: unknown;
  } | null;
  if (typeof value?.baseUrl !== "string" || typeof value?.model !== "string" || typeof value?.path !== "string") {
    throw new CommandError(400, "缺少参数 baseUrl / model / path");
  }
  return transcribe(ctx.access, {
    baseUrl: value.baseUrl,
    model: value.model,
    apiKeyEnv: typeof value.apiKeyEnv === "string" ? value.apiKeyEnv : null,
    headers: (value.headers ?? undefined) as Record<string, string> | undefined,
    path: value.path,
    language: typeof value.language === "string" ? value.language : null,
  });
});

HANDLERS.set("db_automations_load", async (_args, ctx) => ctx.db.loadAutomations());
HANDLERS.set("db_automations_sync", async (args, ctx) => {
  const tasks = (args as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks)) throw new CommandError(400, "缺少参数 tasks");
  ctx.db.syncAutomations(tasks as AutomationTask[]);
  return null;
});
HANDLERS.set("db_automations_due_list", async (_args, ctx) => ctx.db.automationDueList());
HANDLERS.set("db_automations_due_finish", async (args, ctx) => {
  const value = args as { id?: unknown; status?: unknown } | null;
  if (typeof value?.id !== "number" || typeof value?.status !== "string") {
    throw new CommandError(400, "缺少参数 id / status");
  }
  return ctx.db.automationDueFinish(value.id, value.status);
});
HANDLERS.set("db_automation_runs_load", async (args, ctx) => {
  const limit = (args as { limit?: unknown } | null)?.limit;
  return ctx.db.automationRunsLoad(typeof limit === "number" ? limit : 200);
});
HANDLERS.set("db_automation_run_record", async (args, ctx) => {
  const run = (args as { run?: unknown } | null)?.run;
  if (!run || typeof run !== "object") throw new CommandError(400, "缺少参数 run");
  ctx.db.automationRunRecord(run as AutomationRunInput);
  return null;
});
HANDLERS.set("db_team_runs_load", async (_args, ctx) => ctx.db.loadTeamRuns());
HANDLERS.set("db_team_runs_sync", async (args, ctx) => {
  const runs = (args as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(runs)) throw new CommandError(400, "缺少参数 runs");
  ctx.db.syncTeamRuns(runs as TeamRun[]);
  return null;
});
HANDLERS.set("db_agents_load", async (_args, ctx) => ctx.db.loadAgentProviders());
HANDLERS.set("db_agents_sync", async (args, ctx) => {
  const providers = (args as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(providers)) throw new CommandError(400, "缺少参数 providers");
  ctx.db.syncAgentProviders(providers as AgentProvider[]);
  return null;
});
HANDLERS.set("acp_detect_programs", async (args) => {
  const programs = (args as { programs?: unknown } | null)?.programs;
  if (!Array.isArray(programs)) throw new CommandError(400, "缺少参数 programs");
  return detectPrograms(programs as string[]);
});
// 尚无 ACP 会话（acp_start 未迁移）：清单恒为空，形状与 Rust 一致。
HANDLERS.set("acp_list", async () => []);

HANDLERS.set("store_sessions_load", async (args, ctx) => {
  const workspaces = ((args as { workspaces?: unknown } | null)?.workspaces ?? []) as WorkspaceDir[];
  return ctx.store.load(workspaces);
});
HANDLERS.set("store_sessions_sync", async (args, ctx) => {
  const value = args as { snapshot?: unknown; workspaces?: unknown; deletedSessionIds?: unknown } | null;
  if (!value || typeof value.snapshot !== "object" || value.snapshot === null) {
    throw new CommandError(400, "缺少参数 snapshot");
  }
  const workspaces = (value.workspaces ?? []) as WorkspaceDir[];
  const deleted = Array.isArray(value.deletedSessionIds) ? (value.deletedSessionIds as string[]) : [];
  return ctx.store.sync(value.snapshot as { sessions: unknown[]; activeSessionId: string | null }, workspaces, deleted);
});
HANDLERS.set("attachments_prune_session", async (args, ctx) => {
  const sessionId = (args as { sessionId?: unknown } | null)?.sessionId;
  if (typeof sessionId !== "string") throw new CommandError(400, "缺少参数 sessionId");
  ctx.store.pruneAttachments(sessionId);
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

/** 二进制结果（原始字节走 HTTP body，不套 JSON）：`fs_read_binary` 这类命令用。 */
export class BinaryOutput {
  constructor(readonly data: Buffer) {}
}

export type CommandOutput = { kind: "json"; value: unknown } | { kind: "binary"; data: Buffer };

export class CommandError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function dispatch(name: unknown, args: unknown, ctx: CommandContext): Promise<CommandOutput> {
  if (typeof name !== "string" || name === "") {
    throw new CommandError(400, "缺少命令名");
  }
  const meta = COMMANDS.find((item) => item.name === name);
  if (!meta) {
    // 路由层先查命令表：未知命令是 404（不是参数错误 400），与 apps/server 的 run_command 一致。
    throw new CommandError(404, `未知命令: ${name}`);
  }
  if (meta.desktopOnly) {
    throw new CommandError(403, `命令 ${name} 仅桌面端可用`);
  }
  if (isDenied(name, ctx.trustedHost)) {
    throw new CommandError(403, `命令 ${name} 在服务端不可用`);
  }
  const handler = HANDLERS.get(name);
  if (!handler) {
    // 迁移期的明确信号：不是「命令不存在」，而是「这条还没搬过来」。
    throw new CommandError(501, `命令 ${name} 尚未迁移到 Node 宿主`);
  }
  try {
    const value = await handler(args, ctx);
    return value instanceof BinaryOutput ? { kind: "binary", data: value.data } : { kind: "json", value: value ?? null };
  } catch (error) {
    if (error instanceof CommandError) throw error;
    // 与 Rust 的 dispatch 同口径：命令实现失败一律 400 + 原文（前端直接展示这句）。
    throw new CommandError(400, error instanceof Error ? error.message : String(error));
  }
}
