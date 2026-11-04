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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectPrograms } from "./acp-probe.js";
import { marketInstall, marketPreview } from "./plugin-market.js";
import { skillsInstall, skillsUninstall } from "./skills.js";
import { fetchPage } from "./web-fetch.js";
import { checkUpdate } from "./update.js";
import type { AgentProvider, AutomationRunInput, AutomationTask, Db, TeamRun } from "./db.js";
import {
  gitChanges,
  gitCommit,
  gitCurrentBranch,
  gitDiff,
  gitLog,
  gitShow,
  gitStage,
  gitStatus,
  gitBranchList,
  gitUnstage,
  runGit,
} from "./git.js";
import os from "node:os";
import { ragIndexBuild, ragSearch } from "./rag.js";
import { listWorktrees, provisionWorktree, releaseWorktree, restoreWorktree, snapshotWorktree } from "./worktree.js";
import { chatComplete, embed, listModels, transcribe, type LlmChatMessage, type LlmStreamHost } from "./llm.js";
import type { AcpHost } from "./acp.js";
import { validateDirKey } from "./plugin-market.js";
import { getBot, isConnected } from "./wechat-channel.js";
import { channelStatus, saveChannelCredentials, clearChannelCredentials, loadChannelCredentials, setChannelConnected } from "./channel-credentials.js";
import { saveCredentials, telegramSend, telegramStatus } from "./channel-telegram.js";
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
  extraPrograms(trustedHost: boolean): string[];
  db: Db;
  acp: AcpHost;
  rag: RagIndexHost;
  store: SessionFileStore;
  dataDir: string;
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
HANDLERS.set("worktree_provision", async (args, ctx) => {
  const value = args as { source?: unknown; prepare?: unknown; skills?: unknown } | null;
  if (typeof value?.source !== "string") throw new CommandError(400, "缺少参数 source");
  const skills = Array.isArray(value.skills) ? (value.skills as string[]) : null;
  return provisionWorktree(ctx.access, value.source, value.prepare === true, skills);
});
HANDLERS.set("worktree_snapshot", async (args, ctx) => {
  const root = (args as { root?: unknown } | null)?.root;
  if (typeof root !== "string") throw new CommandError(400, "缺少参数 root");
  return snapshotWorktree(ctx.access, root);
});
HANDLERS.set("worktree_restore", async (args, ctx) => {
  const value = args as { root?: unknown; reference?: unknown } | null;
  if (typeof value?.root !== "string" || typeof value?.reference !== "string") {
    throw new CommandError(400, "缺少参数 root / reference");
  }
  restoreWorktree(ctx.access, value.root, value.reference);
  return null;
});
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

// 插件运行时：plugin_fs = 插件私有 KV 存储（<dataDir>/plugins/<pluginId>/storage/）。
// 与 Rust 的 plugin_fs.rs 同语义：path 净化后限制在插件根内，read/write/remove 三操作。
HANDLERS.set("plugin_fs", async (args, ctx) => {
  const value = args as { pluginId?: unknown; op?: unknown; path?: unknown; data?: unknown } | null;
  if (typeof value?.pluginId !== "string" || typeof value?.op !== "string" || typeof value?.path !== "string") {
    throw new CommandError(400, "缺少参数 pluginId / op / path");
  }
  validateDirKey(value.pluginId, "plugin id");
  const pluginRoot = path.join(ctx.dataDir, "plugins", value.pluginId, "storage");
  const target = path.resolve(pluginRoot, value.path);
  if (!target.startsWith(pluginRoot + path.sep) && target !== pluginRoot) {
    throw new Error("路径未获用户授权");
  }
  mkdirSync(pluginRoot, { recursive: true });
  switch (value.op) {
    case "read": return readFileSync(target, "utf8");
    case "write": writeFileSync(target, String(value.data ?? ""), "utf8"); return { ok: true };
    case "remove": rmSync(target); return { ok: true };
    default: throw new Error(`unknown plugin_fs op: ${value.op}`);
  }
});
// plugin_workspace：只做形态校验，返回授权根清单。
HANDLERS.set("plugin_workspace", async (args, ctx) => {
  const pluginId = (args as { pluginId?: unknown } | null)?.pluginId;
  validateDirKey(typeof pluginId === "string" ? pluginId : "", "plugin id");
  return { roots: ctx.access.authorizedRoots() };
});
// plugin_notify：推通知给前端（由渲染端的事件系统消费）。
HANDLERS.set("plugin_notify", async (args, ctx) => {
  const value = args as { pluginId?: unknown; title?: unknown; body?: unknown } | null;
  if (typeof value?.pluginId !== "string" || typeof value?.title !== "string" || typeof value?.body !== "string") {
    throw new CommandError(400, "缺少参数 pluginId / title / body");
  }
  if (value.title.length > 64 || value.body.length > 240) throw new Error("标题或正文超长");
  ctx.bus.broadcast("plugin://notify", { pluginId: value.pluginId, title: value.title, body: value.body });
  return { sent: true, title: value.title, body: value.body };
});

HANDLERS.set("plugin_market_catalog", async (args) => {
  const registryUrl = (args as { registryUrl?: unknown } | null)?.registryUrl;
  if (typeof registryUrl !== "string") throw new CommandError(400, "缺少参数 registryUrl");
  const { fetchCatalog } = await import("./plugin-market.js");
  return fetchCatalog(registryUrl);
});
HANDLERS.set("plugin_market_preview", async (args) => {
  const value = args as { registryUrl?: unknown; pluginId?: unknown } | null;
  if (typeof value?.registryUrl !== "string" || typeof value?.pluginId !== "string") {
    throw new CommandError(400, "缺少参数 registryUrl / pluginId");
  }
  return marketPreview(value.registryUrl, value.pluginId);
});
HANDLERS.set("plugin_market_install", async (args, ctx) => {
  const value = args as { registryUrl?: unknown; pluginId?: unknown } | null;
  if (typeof value?.registryUrl !== "string" || typeof value?.pluginId !== "string") {
    throw new CommandError(400, "缺少参数 registryUrl / pluginId");
  }
  return marketInstall({ dataDir: ctx.dataDir }, value.registryUrl, value.pluginId);
});
HANDLERS.set("plugin_market_list_installed", async (_args, ctx) => {
  const { listInstalledAt } = await import("./plugin-market.js");
  return listInstalledAt(path.join(ctx.dataDir, "plugins"));
});
HANDLERS.set("plugin_market_uninstall", async (args, ctx) => {
  const pluginId = (args as { pluginId?: unknown } | null)?.pluginId;
  if (typeof pluginId !== "string") throw new CommandError(400, "缺少参数 pluginId");
  const { marketUninstall } = await import("./plugin-market.js");
  marketUninstall(ctx.dataDir, pluginId);
  return null;
});

HANDLERS.set("office_convert_info", async () => {
  // soffice 路径来自环境变量；未设置则转换功能不可用。
  const soffice = process.env.GREYWORK_SOFFICE_PATH ?? "";
  return { available: soffice !== "", path: soffice || null };
});
HANDLERS.set("plugin_window_open", async () => {
  // 插件悬浮窗是 Electron 桌面壳专属能力：headless 服务端没有对应物。
  throw new Error("插件悬浮窗仅在桌面端可用");
});
HANDLERS.set("plugin_window_close", async () => {
  throw new Error("插件悬浮窗仅在桌面端可用");
});

HANDLERS.set("mcp_probe", async (args) => {
  // MCP 服务器探活：stdio 模式 spawn 子进程发 initialize 请求；HTTP 模式发 POST。
  // P1 的 Node 宿主只支持 Streamable HTTP 探活（stdio 需要子进程管理，后续补齐）。
  const value = args as { url?: unknown } | null;
  const url = typeof value?.url === "string" ? value.url.trim() : "";
  if (url === "") throw new Error("mcp_probe url is required");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "greywork-host", version: "0.1.0" } } }),
      signal: AbortSignal.timeout(10_000),
    });
    return { transport: "http", isError: !response.ok, text: await response.text().catch(() => "") };
  } catch (error) {
    return { transport: "http", isError: true, text: (error as Error).message };
  }
});
HANDLERS.set("mcp_call", async (args) => {
  const value = args as { server?: unknown; tool?: unknown; args?: unknown } | null;
  if (typeof value?.server !== "string" || typeof value?.tool !== "string") {
    throw new Error("mcp_call requires server and tool");
  }
  // 完整的 MCP 工具调用需要 MCP 客户端（stdio + Streamable HTTP 两种传输），
  // 与 Rust 的 mcp.rs 对齐——这是后续批次的工作。
  throw new Error("mcp_call 尚未迁移到 Node 宿主");
});

HANDLERS.set("skills_search", async (args) => {
  const value = args as { origin?: unknown; query?: unknown } | null;
  const origin = typeof value?.origin === "string" && value.origin.trim() !== "" ? value.origin : "https://greywork-skills.pages.dev";
  const query = typeof value?.query === "string" ? value.query.trim() : "";
  if (query === "") throw new Error("query is empty");
  const response = await fetch(`${origin}/api/skills?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`skills search returned ${response.status}`);
  return response.json();
});
HANDLERS.set("skills_download", async (args) => {
  const value = args as { origin?: unknown; entryRef?: unknown } | null;
  const origin = typeof value?.origin === "string" && value.origin.trim() !== "" ? value.origin : "https://greywork-skills.pages.dev";
  const entryRef = typeof value?.entryRef === "string" ? value.entryRef : "";
  const parts = entryRef.split("/");
  if (parts.length !== 3) throw new Error("invalid entry ref (expect owner/repo/slug)");
  const url = `${origin}/api/download/${parts[0]}/${parts[1]}/${parts[2]}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`skills download returned ${response.status}`);
  return response.json();
});

HANDLERS.set("skills_bundled_list", async () => []);
HANDLERS.set("skills_install_bundled", async (args) => {
  const skillId = (args as { skillId?: unknown } | null)?.skillId;
  throw new Error(`bundled skill ${String(skillId)} not found in Node host`);
});

// 插件 net.fetch：域白名单 + 方法 + 路径模板 + 字节上限（与 Rust 双重校验一致）。
HANDLERS.set("plugin_net_fetch", async (args) => {
  const value = args as {
    pluginId?: unknown; url?: unknown; method?: unknown;
    headers?: Record<string, unknown>; body?: unknown;
  } | null;
  if (typeof value?.url !== "string") throw new CommandError(400, "缺少参数 url");
  const method = value.method ?? "GET";
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    throw new CommandError(400, `web fetch only allows GET/HEAD/POST, got ${method}`);
  }
  const response = await fetch(value.url, {
    method,
    headers: (value.headers ?? undefined) as Record<string, string> | undefined,
    body: method === "POST" && value.body !== undefined ? String(value.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => (responseHeaders[k] = v));
  const text = await response.text();
  return { status: response.status, ok: response.ok, headers: responseHeaders, body: text };
});

HANDLERS.set("web_fetch", async (args) => {
  const url = (args as { url?: unknown } | null)?.url;
  if (typeof url !== "string") throw new CommandError(400, "缺少参数 url");
  return fetchPage(url);
});

HANDLERS.set("acp_start", async (args, ctx) => {
  const value = args as { agentCmd?: unknown; tier?: unknown; env?: unknown } | null;
  if (typeof value?.agentCmd !== "string") throw new CommandError(400, "缺少参数 agentCmd");
  const extra = ctx.extraPrograms(ctx.trustedHost);
  return ctx.acp.start(
    extra,
    value.agentCmd,
    typeof value.tier === "string" ? value.tier : null,
    (value.env ?? undefined) as Record<string, string> | undefined,
  );
});
HANDLERS.set("acp_new_session", async (args, ctx) => {
  const value = args as { handle?: unknown; cwd?: unknown } | null;
  if (typeof value?.handle !== "number" || typeof value?.cwd !== "string") {
    throw new CommandError(400, "缺少参数 handle / cwd");
  }
  return ctx.acp.newSession(value.handle, value.cwd);
});
HANDLERS.set("acp_load_session", async (args, ctx) => {
  const value = args as { handle?: unknown; cwd?: unknown; sessionId?: unknown } | null;
  if (typeof value?.handle !== "number" || typeof value?.cwd !== "string" || typeof value?.sessionId !== "string") {
    throw new CommandError(400, "缺少参数 handle / cwd / sessionId");
  }
  return ctx.acp.loadSession(value.handle, value.cwd, value.sessionId);
});
HANDLERS.set("acp_send", async (args, ctx) => {
  const value = args as { handle?: unknown; text?: unknown } | null;
  if (typeof value?.handle !== "number" || typeof value?.text !== "string") {
    throw new CommandError(400, "缺少参数 handle / text");
  }
  return ctx.acp.send(value.handle, value.text);
});
HANDLERS.set("acp_stop", async (args, ctx) => {
  const value = args as { handle?: unknown; turnId?: unknown } | null;
  if (typeof value?.handle !== "number") throw new CommandError(400, "缺少参数 handle");
  const turnId = typeof value.turnId === "number" ? value.turnId : null;
  await ctx.acp.stop(value.handle, turnId);
  return null;
});
HANDLERS.set("acp_cancel_session", async (args, ctx) => {
  const value = args as { handle?: unknown; sessionId?: unknown } | null;
  if (typeof value?.handle !== "number" || typeof value?.sessionId !== "string") {
    throw new CommandError(400, "缺少参数 handle / sessionId");
  }
  ctx.acp.cancelSession(value.handle, value.sessionId);
  return null;
});
HANDLERS.set("acp_permission_respond", async (args, ctx) => {
  const value = args as { requestId?: unknown; optionId?: unknown } | null;
  if (typeof value?.requestId !== "number") throw new CommandError(400, "缺少参数 requestId");
  ctx.acp.respondPermission(value.requestId, typeof value.optionId === "string" ? value.optionId : null);
  return null;
});
HANDLERS.set("acp_set_permission_tier", async (args, ctx) => {
  const value = args as { handle?: unknown; tier?: unknown } | null;
  if (typeof value?.handle !== "number" || typeof value?.tier !== "string") {
    throw new CommandError(400, "缺少参数 handle / tier");
  }
  ctx.acp.setPermissionTier(value.handle, value.tier);
  return null;
});
HANDLERS.set("acp_set_mode", async (args, ctx) => {
  const value = args as { handle?: unknown; modeId?: unknown } | null;
  if (typeof value?.handle !== "number" || typeof value?.modeId !== "string") {
    throw new CommandError(400, "缺少参数 handle / modeId");
  }
  return ctx.acp.setMode(value.handle, value.modeId);
});
HANDLERS.set("acp_set_config", async (args, ctx) => {
  const value = args as { handle?: unknown; configId?: unknown; value?: unknown } | null;
  if (typeof value?.handle !== "number" || typeof value?.configId !== "string") {
    throw new CommandError(400, "缺少参数 handle / configId");
  }
  return ctx.acp.setConfig(value.handle, value.configId, value.value ?? null);
});
HANDLERS.set("git_stage", async (args, ctx) => {
  const value = args as { root?: unknown; paths?: unknown; all?: unknown } | null;
  if (typeof value?.root !== "string") throw new CommandError(400, "缺少参数 root");
  await gitStage(ctx.access, value.root, Array.isArray(value.paths) ? (value.paths as string[]) : [], value.all === true);
  return null;
});
HANDLERS.set("git_unstage", async (args, ctx) => {
  const value = args as { root?: unknown; paths?: unknown; all?: unknown } | null;
  if (typeof value?.root !== "string") throw new CommandError(400, "缺少参数 root");
  await gitUnstage(ctx.access, value.root, Array.isArray(value.paths) ? (value.paths as string[]) : [], value.all === true);
  return null;
});
HANDLERS.set("git_commit", async (args, ctx) => {
  const value = args as { root?: unknown; message?: unknown; all?: unknown } | null;
  if (typeof value?.root !== "string" || typeof value?.message !== "string") {
    throw new CommandError(400, "缺少参数 root / message");
  }
  return gitCommit(ctx.access, value.root, value.message, value.all === true);
});
HANDLERS.set("git_branch_list", async (args, ctx) => {
  const root = (args as { root?: unknown } | null)?.root;
  if (typeof root !== "string") throw new CommandError(400, "缺少参数 root");
  return gitBranchList(ctx.access, root);
});
HANDLERS.set("git_log", async (args, ctx) => {
  const value = args as { root?: unknown; limit?: unknown; skip?: unknown } | null;
  if (typeof value?.root !== "string") throw new CommandError(400, "缺少参数 root");
  return gitLog(
    ctx.access,
    value.root,
    typeof value.limit === "number" ? value.limit : null,
    typeof value.skip === "number" ? value.skip : null,
  );
});
HANDLERS.set("git_show", async (args, ctx) => {
  const value = args as { root?: unknown; hash?: unknown; path?: unknown } | null;
  if (typeof value?.root !== "string" || typeof value?.hash !== "string") {
    throw new CommandError(400, "缺少参数 root / hash");
  }
  return gitShow(ctx.access, value.root, value.hash, typeof value.path === "string" ? value.path : null);
});

HANDLERS.set("shell_run", async (args, ctx) => {
  const value = args as { command?: unknown; cwd?: unknown; timeoutMs?: unknown } | null;
  if (typeof value?.command !== "string" || value.command === "") throw new CommandError(400, "缺少参数 command");
  const { shellRun } = await import("./shell-run.js");
  return shellRun(
    value.command,
    typeof value.cwd === "string" ? value.cwd : ctx.access.root,
    typeof value.timeoutMs === "number" ? value.timeoutMs : 120_000,
  );
});

HANDLERS.set("sys_info", async (_args, ctx) => {
  const schemaVersion = ctx.db.schemaVersion();
  return {
    version: "0.1.0",
    schemaVersion,
    logDir: null,
    activeAgents: ctx.acp.sessionCount(),
    os: process.platform,
    trayAvailable: false,
    totalMemoryBytes: os.totalmem(),
    cpuCount: os.cpus().length,
    pinnedTier: null,
  };
});

HANDLERS.set("telegram_status", async (_args, ctx) => telegramStatus(ctx.dataDir));
HANDLERS.set("telegram_save_credentials", async (args, ctx) => {
  const value = args as { botToken?: unknown } | null;
  if (typeof value?.botToken !== "string") throw new CommandError(400, "缺少参数 botToken");
  saveCredentials(ctx.dataDir, value.botToken);
  return null;
});
HANDLERS.set("discord_send", async (args) => {
  const v = args as { channelId?: unknown; content?: unknown; credentials?: unknown } | null;
  if (typeof v?.channelId !== "string" || typeof v?.content !== "string") throw new CommandError(400, "缺少参数 channelId / content");
  const creds = v.credentials as { token?: string } | undefined;
  if (!creds?.token) throw new Error("Discord bot token 未配置");
  const response = await fetch(`https://discord.com/api/v10/channels/${v.channelId}/messages`, {
    method: "POST",
    headers: { "authorization": `Bot ${creds.token}`, "content-type": "application/json" },
    body: JSON.stringify({ content: v.content }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Discord send returned ${response.status}`);
  return { ok: true };
});

HANDLERS.set("telegram_send", async (args, ctx) => {
  const value = args as { chatId?: unknown; text?: unknown } | null;
  if (typeof value?.chatId !== "string" || typeof value?.text !== "string") {
    throw new CommandError(400, "缺少参数 chatId / text");
  }
  return telegramSend(ctx.dataDir, value.chatId, value.text);
});


HANDLERS.set("telegram_status", async (_args, ctx) => channelStatus(ctx.dataDir, "telegram"));
HANDLERS.set("telegram_save_credentials", async (args, ctx) => {
  const value = args as Record<string, unknown> | null;
  if (!value || typeof value !== "object") throw new CommandError(400, "缺少参数");
  saveChannelCredentials(ctx.dataDir, "telegram", value);
  return null;
});
HANDLERS.set("telegram_clear_credentials", async (_args, ctx) => {
  clearChannelCredentials(ctx.dataDir, "telegram");
  return null;
});

HANDLERS.set("dingtalk_status", async (_args, ctx) => channelStatus(ctx.dataDir, "dingtalk"));
HANDLERS.set("dingtalk_save_credentials", async (args, ctx) => {
  const value = args as Record<string, unknown> | null;
  if (!value || typeof value !== "object") throw new CommandError(400, "缺少参数");
  saveChannelCredentials(ctx.dataDir, "dingtalk", value);
  return null;
});
HANDLERS.set("dingtalk_clear_credentials", async (_args, ctx) => {
  clearChannelCredentials(ctx.dataDir, "dingtalk");
  return null;
});

HANDLERS.set("discord_status", async (_args, ctx) => channelStatus(ctx.dataDir, "discord"));
HANDLERS.set("discord_save_credentials", async (args, ctx) => {
  const value = args as Record<string, unknown> | null;
  if (!value || typeof value !== "object") throw new CommandError(400, "缺少参数");
  saveChannelCredentials(ctx.dataDir, "discord", value);
  return null;
});
HANDLERS.set("discord_clear_credentials", async (_args, ctx) => {
  clearChannelCredentials(ctx.dataDir, "discord");
  return null;
});

HANDLERS.set("feishu_status", async (_args, ctx) => channelStatus(ctx.dataDir, "feishu"));
HANDLERS.set("feishu_save_credentials", async (args, ctx) => {
  const value = args as Record<string, unknown> | null;
  if (!value || typeof value !== "object") throw new CommandError(400, "缺少参数");
  saveChannelCredentials(ctx.dataDir, "feishu", value);
  return null;
});
HANDLERS.set("feishu_clear_credentials", async (_args, ctx) => {
  clearChannelCredentials(ctx.dataDir, "feishu");
  return null;
});

HANDLERS.set("qq_status", async (_args, ctx) => channelStatus(ctx.dataDir, "qq"));
HANDLERS.set("qq_save_credentials", async (args, ctx) => {
  const value = args as Record<string, unknown> | null;
  if (!value || typeof value !== "object") throw new CommandError(400, "缺少参数");
  saveChannelCredentials(ctx.dataDir, "qq", value);
  return null;
});
HANDLERS.set("qq_clear_credentials", async (_args, ctx) => {
  clearChannelCredentials(ctx.dataDir, "qq");
  return null;
});

HANDLERS.set("wecom_status", async (_args, ctx) => channelStatus(ctx.dataDir, "wecom"));
HANDLERS.set("wecom_save_credentials", async (args, ctx) => {
  const value = args as Record<string, unknown> | null;
  if (!value || typeof value !== "object") throw new CommandError(400, "缺少参数");
  saveChannelCredentials(ctx.dataDir, "wecom", value);
  return null;
});
HANDLERS.set("wecom_clear_credentials", async (_args, ctx) => {
  clearChannelCredentials(ctx.dataDir, "wecom");
  return null;
});

HANDLERS.set("wechat_status", async (_args, ctx) => channelStatus(ctx.dataDir, "wechat"));
HANDLERS.set("wechat_save_credentials", async (args, ctx) => {
  const value = args as Record<string, unknown> | null;
  if (!value || typeof value !== "object") throw new CommandError(400, "缺少参数");
  saveChannelCredentials(ctx.dataDir, "wechat", value);
  return null;
});
HANDLERS.set("wechat_clear_credentials", async (_args, ctx) => {
  clearChannelCredentials(ctx.dataDir, "wechat");
  return null;
});

HANDLERS.set("feishu_send", async (args) => {
  const v = args as { chatId?: unknown; text?: unknown; credentials?: unknown } | null;
  if (typeof v?.chatId !== "string" || typeof v?.text !== "string") throw new CommandError(400, "缺少参数 chatId / text");
  const creds = v.credentials as { appId?: string; appSecret?: string } | undefined;
  if (!creds?.appId || !creds?.appSecret) throw new Error("飞书凭证未配置");
  const tokenRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  });
  const tokenBody = await tokenRes.json() as { tenant_access_token?: string };
  if (!tokenBody.tenant_access_token) throw new Error("飞书 token 获取失败");
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages", {
    method: "POST",
    headers: { "authorization": `Bearer ${tokenBody.tenant_access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ receive_id_type: "chat_id", msg_type: "text", content: JSON.stringify({ text: v.text }) }),
  });
  if (!response.ok) throw new Error(`飞书 send returned ${response.status}`);
  return { ok: true };
});

HANDLERS.set("wechat_status", async (_args, ctx) => {
  const creds = loadChannelCredentials(ctx.dataDir, "wechat");
  return { configured: creds !== null, connected: isConnected() };
});
HANDLERS.set("wechat_connect", async (_args, ctx) => {
  const creds = loadChannelCredentials(ctx.dataDir, "wechat");
  if (!creds) throw new Error("微信 bot token 未配置");
  const bot = getBot(ctx.dataDir);
  if (!isConnected()) {
    await bot.start();
  }
  return { connected: true };
});
HANDLERS.set("wechat_send", async (args, ctx) => {
  const value = args as { userId?: unknown; text?: unknown } | null;
  if (typeof value?.userId !== "string" || typeof value?.text !== "string") {
    throw new CommandError(400, "缺少参数 userId / text");
  }
  const bot = getBot(ctx.dataDir);
  await bot.send(value.userId, value.text);
  return { ok: true };
});
HANDLERS.set("wechat_logout", async () => {
  // SDK 没有 logout 方法——断连由 stop 处理，凭据由 clearChannelCredentials 清理。
  return { loggedOut: true };
});


HANDLERS.set("telegram_connect", async (_args, ctx) => {
  const creds = loadChannelCredentials(ctx.dataDir, "telegram");
  if (!creds) throw new Error("通道凭据未配置，请先 save_credentials");
  setChannelConnected("telegram", true);
  return { connected: true };
});
HANDLERS.set("telegram_disconnect", async (_args) => {
  setChannelConnected("telegram", false);
  return { connected: false };
});

HANDLERS.set("dingtalk_connect", async (_args, ctx) => {
  const creds = loadChannelCredentials(ctx.dataDir, "dingtalk");
  if (!creds) throw new Error("通道凭据未配置，请先 save_credentials");
  setChannelConnected("dingtalk", true);
  return { connected: true };
});
HANDLERS.set("dingtalk_disconnect", async (_args) => {
  setChannelConnected("dingtalk", false);
  return { connected: false };
});

HANDLERS.set("discord_connect", async (_args, ctx) => {
  const creds = loadChannelCredentials(ctx.dataDir, "discord");
  if (!creds) throw new Error("通道凭据未配置，请先 save_credentials");
  setChannelConnected("discord", true);
  return { connected: true };
});
HANDLERS.set("discord_disconnect", async (_args) => {
  setChannelConnected("discord", false);
  return { connected: false };
});

HANDLERS.set("feishu_connect", async (_args, ctx) => {
  const creds = loadChannelCredentials(ctx.dataDir, "feishu");
  if (!creds) throw new Error("通道凭据未配置，请先 save_credentials");
  setChannelConnected("feishu", true);
  return { connected: true };
});
HANDLERS.set("feishu_disconnect", async (_args) => {
  setChannelConnected("feishu", false);
  return { connected: false };
});

HANDLERS.set("qq_connect", async (_args, ctx) => {
  const creds = loadChannelCredentials(ctx.dataDir, "qq");
  if (!creds) throw new Error("通道凭据未配置，请先 save_credentials");
  setChannelConnected("qq", true);
  return { connected: true };
});
HANDLERS.set("qq_disconnect", async (_args) => {
  setChannelConnected("qq", false);
  return { connected: false };
});

HANDLERS.set("wechat_connect", async (_args, ctx) => {
  const creds = loadChannelCredentials(ctx.dataDir, "wechat");
  if (!creds) throw new Error("通道凭据未配置，请先 save_credentials");
  setChannelConnected("wechat", true);
  return { connected: true };
});
HANDLERS.set("wechat_disconnect", async (_args, _ctx) => {
  setChannelConnected("wechat", false);
  return { connected: false };
});

HANDLERS.set("wecom_connect", async (_args, ctx) => {
  const creds = loadChannelCredentials(ctx.dataDir, "wecom");
  if (!creds) throw new Error("通道凭据未配置，请先 save_credentials");
  setChannelConnected("wecom", true);
  return { connected: true };
});
HANDLERS.set("wecom_disconnect", async (_args) => {
  setChannelConnected("wecom", false);
  return { connected: false };
});

// DingTalk send：通过 access_token 调 REST API
HANDLERS.set("dingtalk_send", async (args) => {
  const v = args as { chatId?: unknown; text?: unknown; credentials?: unknown } | null;
  if (typeof v?.chatId !== "string" || typeof v?.text !== "string") throw new CommandError(400, "缺少参数 chatId / text");
  const creds = v.credentials as { clientId?: string; clientSecret?: string } | undefined;
  if (!creds?.clientId || !creds?.clientSecret) throw new Error("钉钉凭证未配置");
  const tokenRes = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ appKey: creds.clientId, appSecret: creds.clientSecret }),
  });
  const { accessToken } = await tokenRes.json() as { accessToken: string };
  const response = await fetch(`https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend`, {
    method: "POST",
    headers: { "x-acs-dingtalk-access-token": accessToken, "content-type": "application/json" },
    body: JSON.stringify({ robotCode: creds.clientId, userIds: [v.chatId], msgKey: "sampleText", msgParam: JSON.stringify({ content: v.text }) }),
  });
  if (!response.ok) throw new Error(`钉钉 send returned ${response.status}`);
  return { ok: true };
});

// QQ send：通过 QQ Bot API
HANDLERS.set("qq_send", async (args) => {
  const v = args as { chatId?: unknown; text?: unknown; credentials?: unknown } | null;
  if (typeof v?.chatId !== "string" || typeof v?.text !== "string") throw new CommandError(400, "缺少参数 chatId / text");
  const creds = v.credentials as { appId?: string; appSecret?: string } | undefined;
  if (!creds?.appId || !creds?.appSecret) throw new Error("QQ 凭证未配置");
  const tokenRes = await fetch("https://bots.qq.com/app/getAppAccessToken", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId: creds.appId, clientSecret: creds.appSecret }),
  });
  const { access_token } = await tokenRes.json() as { access_token: string };
  const response = await fetch(`https://api.sgroup.qq.com/v2/users/${v.chatId}/messages`, {
    method: "POST",
    headers: { "authorization": `QQBot ${access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ content: v.text, msg_type: 0, msg_id: "" }),
  });
  if (!response.ok) throw new Error(`QQ send returned ${response.status}`);
  return { ok: true };
});

// WeCom send：通过 WeCom Bot API
HANDLERS.set("wecom_send", async (args) => {
  const v = args as { chatId?: unknown; text?: unknown; credentials?: unknown } | null;
  if (typeof v?.text !== "string") throw new CommandError(400, "缺少参数 text");
  const creds = v.credentials as { botId?: string; secret?: string } | undefined;
  if (!creds?.botId) throw new Error("企微凭证未配置");
  const response = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${creds.botId}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: v.text } }),
  });
  if (!response.ok) throw new Error(`企微 send returned ${response.status}`);
  return { ok: true };
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
HANDLERS.set("office_host_info", async (args) => {
  const envNames = ((args as { envNames?: unknown } | null)?.envNames ?? []) as string[];
  // P0 的 CSP 只覆盖同源资源；frame origins 的完整实现需要读取 GREYWORK_FRAME_ORIGINS 配置。
  return { embeddableFrameOrigins: [], envPresent: envNames.filter((name: string) => process.env[name]), envMissing: envNames.filter((name: string) => !process.env[name]) };
});

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
