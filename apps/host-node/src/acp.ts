/**
 * ACP 会话托管：外部 agent 子进程（JSON-RPC 2.0 over stdio，行分隔）。
 *
 * 移植 `services/acp_host/` 的核心语义：
 * - `acp_start`：命令白名单（内置名单 + 用户目录启用的程序）→ spawn → initialize 握手
 *   （npx/npm 冷启动放宽到 120s，其余 10s）；
 * - `acp_new_session` / `acp_load_session` / `acp_send`：会话与回合管理，输出经
 *   `acp://event` 分类广播（thought / usage / commands / config-options / mode /
 *   session-update），回合结束推 `prompt-done`；
 * - 权限请求：`session/request_permission` 转成 `permission-request` 事件等前端裁决，
 *   `acp_permission_respond` 应答；stop / cancel 释放全部待决项（按取消应答）；
 * - `acp_stop`：turn_id 精确取消（session/cancel + $/cancel_request 兜底）；
 *   无 turn_id 回收整棵进程树。
 *
 * 已知差异（后续补齐）：权限档位的自动放行/越界拦截比 Rust 的 policy.rs 简化
 * （tier=full 自动放行含 Allow 的请求；read-only 对非读取类自动拒绝）。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";

import { scanTurnArtifacts } from "./acp-artifacts.js";
import type { EventBus } from "./events.js";
import type { WorkspaceAccess } from "./workspace-access.js";

export const ALLOWED_AGENT_PROGRAMS = new Set([
  "opencode",
  "codex",
  "claude",
  "gemini",
  "crush",
  "qwen",
  "droid",
  "amp",
  "amp-acp",
  "kimi",
  "glm-acp-agent",
  "goose",
  "copilot",
  "cursor-agent",
  "aider",
  "node",
  "npx",
  "bun",
  "bunx",
  "deno",
]);

/** 回收 agent 进程树：Windows 上命令可能经 cmd.exe 包装，必须 /T 连子进程一起杀。 */
function killAgentTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    // 已退出。
  }
}

export type PermissionTier = "read-only" | "workspace" | "full";

export function parseTier(tier: string | null | undefined): PermissionTier {
  const value = (tier ?? "").trim().toLowerCase();
  if (value === "read-only") return "read-only";
  if (value === "full") return "full";
  return "workspace";
}

/** spawn 面的命令校验：首 token 必须在白名单（basename），禁止 shell 元字符。 */
export function validateSpawnCommand(agentCmd: string, extra: string[]): string {
  const trimmed = agentCmd.trim();
  const banned = /[`;&|<>$(){}[\]]/.test(trimmed);
  const program = trimmed.split(/\s+/)[0] ?? "";
  const base = path.basename(program).toLowerCase();
  if (banned || base === "" || (!ALLOWED_AGENT_PROGRAMS.has(base) && !extra.map((item) => item.toLowerCase()).includes(base))) {
    throw new Error(`agent program not allowed: ${program}`);
  }
  return trimmed;
}

function handshakeTimeoutSecs(command: string): number {
  const program = command.split(/\s+/)[0] ?? "";
  return ["npx", "npm", "yarn", "pnpm", "deno", "bunx"].includes(program) ? 120 : 10;
}

/**
 * 渲染端下发的 MCP 服务器声明 → ACP `session/new` 的 McpServer 形态。
 *
 * stdio → { name, command, args, env }；http / sse → { type, name, url, headers }。
 * 只转发 agent 在 initialize 里声明支持的传输（与 Rust 版同语义）；缺参数或能力不匹配的
 * 条目记进 `skipped`，由调用方带回 `skippedMcpServers` 供 UI 解释。
 */
interface McpDeclaration {
  servers: Record<string, unknown>[];
  declared: string[];
  skipped: { name: string; reason: string }[];
}

function toAcpMcpServers(raw: unknown, caps: { http: boolean; sse: boolean }): McpDeclaration {
  const pairs = (value: unknown): { name: string; value: string }[] => {
    if (Array.isArray(value)) {
      return value.flatMap((entry) => {
        const item = entry as { name?: unknown; value?: unknown } | null;
        return typeof item?.name === "string" && typeof item.value === "string"
          ? [{ name: item.name, value: item.value }]
          : [];
      });
    }
    if (value !== null && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>).flatMap(([name, item]) =>
        typeof item === "string" ? [{ name, value: item }] : [],
      );
    }
    return [];
  };

  const result: McpDeclaration = { servers: [], declared: [], skipped: [] };
  if (!Array.isArray(raw)) return result;
  for (const entry of raw) {
    const server = entry as Record<string, unknown> | null;
    if (!server || typeof server.name !== "string" || server.name.trim() === "") continue;
    const name = server.name;
    if (server.transport === "stdio") {
      if (typeof server.command !== "string" || server.command.trim() === "") {
        result.skipped.push({ name, reason: "missing_command" });
        continue;
      }
      result.servers.push({
        name,
        command: server.command,
        args: Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === "string") : [],
        env: pairs(server.env),
      });
      result.declared.push(name);
      continue;
    }
    if (server.transport === "http" || server.transport === "sse") {
      if (typeof server.url !== "string" || server.url.trim() === "") {
        result.skipped.push({ name, reason: "missing_url" });
        continue;
      }
      const supported = server.transport === "http" ? caps.http : caps.sse;
      if (!supported) {
        result.skipped.push({ name, reason: `${server.transport}_unsupported` });
        continue;
      }
      result.servers.push({
        type: server.transport,
        name,
        url: server.url,
        headers: pairs(server.headers),
      });
      result.declared.push(name);
      continue;
    }
    result.skipped.push({ name, reason: `unknown_transport:${String(server.transport)}` });
  }
  return result;
}

export interface OpenArgs {
  sessionId?: unknown;
  cwd?: unknown;
  shell?: unknown;
  cols?: unknown;
  rows?: unknown;
}

interface AcpSession {
  command: string;
  proc: ChildProcess;
  nextId: number;
  /** agent → 宿主的 JSON-RPC 请求应答（session/request_permission）。 */
  respond?: (id: number, result: unknown) => void;
  request?: (method: string, params: unknown) => Promise<unknown>;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  sessionId?: string;
  turns: Map<number, number | string>;
  tier: PermissionTier;
  workspaceRoot: string | null;
  loadSession: boolean;
  resumeSession: boolean;
  closeSession: boolean;
  imagePrompts: boolean;
  /** initialize 里声明支持的 MCP 传输（未声明视为不支持，与 Rust 版同语义）。 */
  mcpHttp: boolean;
  mcpSse: boolean;
  modes: unknown | null;
  exited: boolean;
  stderrTail: string[];
}

export class AcpHost {
  private nextId = 0;
  private nextPermissionId = 0;
  private nextTurnId = 0;
  private readonly sessions = new Map<number, AcpSession>();
  private readonly pendingPermissions = new Map<number, { sessionId: string | null; resolve: (optionId: string | null) => void }>();

  constructor(
    private readonly bus: EventBus,
    private readonly access: WorkspaceAccess,
  ) {}

  sessionCount(): number {
    return this.sessions.size;
  }

  private emit(kind: string, payload: Record<string, unknown>): void {
    this.bus.broadcast("acp://event", { kind, payload });
  }

  /** 命令面上下文：白名单外额外放行用户目录里启用的程序（仅可信宿主读库）。 */
  extraPrograms(trustedHost: boolean, db: { enabledAgentPrograms(): string[] }): string[] {
    return trustedHost ? db.enabledAgentPrograms() : [];
  }

  async start(
    extraPrograms: string[],
    agentCmd: string,
    tier: string | null,
    envVars: Record<string, string> | undefined,
  ): Promise<number> {
    const command = validateSpawnCommand(agentCmd, extraPrograms);
    const timeoutMs = handshakeTimeoutSecs(command) * 1000;
    const handle = this.nextId++;
    const parts = command.split(/\s+/);
    // Windows 上 npm 全局命令（npx / opencode / claude …）是 .cmd 包装，spawn 直接执行会 ENOENT；
    // 交给 shell 解析才能命中 PATHEXT。命令本身已过白名单与 shell 元字符校验。
    const useShell = process.platform === "win32";
    const proc = spawn(useShell ? command : parts[0], useShell ? [] : parts.slice(1), {
      cwd: process.cwd(),
      env: { ...process.env, ...envVars },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: useShell,
    });
    const stderrTail: string[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrTail.push(String(chunk));
      if (stderrTail.length > 20) stderrTail.shift();
    });

    const session: AcpSession = {
      command,
      proc,
      nextId: 0,
      pending: new Map(),
      turns: new Map(),
      tier: parseTier(tier),
      workspaceRoot: null,
      loadSession: false,
      resumeSession: false,
      closeSession: false,
      imagePrompts: false,
      mcpHttp: false,
      mcpSse: false,
      modes: null,
      exited: false,
      stderrTail,
    };
    this.sessions.set(handle, session);

    // spawn 失败（ENOENT / EACCES…）以 'error' 事件抛出：不接住就是未捕获异常，
    // 在 sidecar 里等于整个宿主进程退出（Electron 见 sidecar 退出会直接 quit）。
    const spawnFailure = new Promise<never>((_, reject) => {
      proc.once("error", (error) => {
        this.sessions.delete(handle);
        const hint =
          process.platform === "win32"
            ? "（Windows 上 npm 全局命令需要 .cmd 包装；宿主已改用 shell 启动，若仍失败请确认命令在 PATH 里）"
            : "";
        reject(new Error(`agent 启动失败：${command}${hint} — ${error.message}`));
      });
    });
    const ready = this.attach(session, proc);
    const version = await Promise.race([
      ready,
      spawnFailure,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          const hint = stderrTail.length > 0 ? `\nstderr 尾部: ${stderrTail.join("").slice(-400)}` : "";
          reject(
            new Error(
              `agent handshake timeout after ${timeoutMs / 1000}s: '${command}' did not become ready (npx/npm 首次运行需下载，可再试一次)${hint}`,
            ),
          );
        }, timeoutMs),
      ),
    ]);
    // 握手回包：能力面
    const version2 = version as {
      agentCapabilities?: {
        loadSession?: boolean;
        sessionCapabilities?: { resume?: boolean; close?: boolean };
        mcpCapabilities?: { http?: boolean; sse?: boolean };
      };
      promptCapabilities?: { image?: boolean };
    };
    const capabilities = version2.agentCapabilities ?? {};
    session.loadSession = capabilities.loadSession === true;
    session.resumeSession = capabilities.sessionCapabilities?.resume === true;
    session.closeSession = capabilities.sessionCapabilities?.close === true;
    session.imagePrompts = version2.promptCapabilities?.image === true;
    session.mcpHttp = capabilities.mcpCapabilities?.http === true;
    session.mcpSse = capabilities.mcpCapabilities?.sse === true;
    return handle;
  }

  /** 挂接 stdio：行分隔 JSON-RPC；请求=权限，通知=分类转发。 */
  private attach(session: AcpSession, proc: ChildProcess): Promise<unknown> {
    const send = (message: Record<string, unknown>) => {
      proc.stdin?.write(JSON.stringify(message) + "\n");
    };
    session.request = (method: string, params: unknown): Promise<unknown> => {
      const id = ++session.nextId;
      return new Promise((resolve, reject) => {
        session.pending.set(id, { resolve, reject });
        send({ jsonrpc: "2.0", id, method, params });
      });
    };
    session.respond = (id: number, result: unknown) => send({ jsonrpc: "2.0", id, result });

    const ready = session.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });

    let buffer = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line === "") continue;
        let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
          const pending = session.pending.get(Number(message.id));
          if (pending) {
            session.pending.delete(Number(message.id));
            if (message.error !== undefined) {
              const detail = (message.error as { message?: unknown }).message;
              pending.reject(new Error(String(detail ?? "agent error")));
            } else {
              pending.resolve(message.result);
            }
          }
          continue;
        }
        if (typeof message.method === "string") {
          this.onAgentMessage(session, message.method, message.params, message.id);
        }
      }
    });
    proc.once("exit", () => {
      session.exited = true;
    });
    return ready;
  }

  /** agent → 宿主：权限请求登记 pending 并广播；其余方法忽略。 */
  private onAgentMessage(session: AcpSession, method: string, params: unknown, id: unknown): void {
    if (method === "session/update") {
      this.classifyNotification(params);
      return;
    }
    if (method === "session/request_permission" && typeof id === "number") {
      const value = params as {
        sessionId?: unknown;
        toolCall?: { toolCallId?: unknown; fields?: { title?: unknown; kind?: unknown } };
        options?: { id?: unknown; name?: unknown; kind?: unknown }[];
      };
      const requestId = this.nextPermissionId++;
      const sessionId = typeof value.sessionId === "string" ? value.sessionId : null;
      const resolve = (optionId: string | null) => {
        // 应答回给 agent（JSON-RPC response），按 Rust 的 RequestPermissionOutcome 形状。
        if (typeof id === "number") {
          session.respond?.(id, {
            outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId },
          });
        }
      };
      this.pendingPermissions.set(requestId, { sessionId, resolve });
      this.emit("permission-request", {
        requestId: requestId as unknown as number,
        sessionId,
        auto: false,
        chosen: null,
        toolCallId: String(value.toolCall?.toolCallId ?? ""),
        title: value.toolCall?.fields?.title ?? "未命名工具调用",
        kind: String(value.toolCall?.fields?.kind ?? "other"),
        options: value.options ?? [],
      });
      return;
    }
    void id;
  }

  /** 按 ACP SessionUpdate 变体分类转发；未识别的保持原始 session-update 载荷。 */
  private classifyNotification(params: unknown): void {
    const value = params as { sessionId?: unknown; update?: Record<string, unknown> };
    const sessionId = String(value.sessionId ?? "");
    const update = value.update ?? {};
    const kind = String(update.sessionUpdate ?? "");
    switch (kind) {
      case "agent_thought_chunk": {
        const content = update.content as { text?: unknown } | undefined;
        this.emit("thought", { sessionId, text: typeof content?.text === "string" ? content.text : "", messageId: update.messageId });
        return;
      }
      case "usage_update":
        this.emit("usage", { sessionId, used: update.used, size: update.size, cost: update.cost, meta: update.meta });
        return;
      case "available_commands_update":
        this.emit("commands", { sessionId, availableCommands: update.availableCommands });
        return;
      case "config_option_update":
        this.emit("config-options", { sessionId, configOptions: update.configOptions });
        return;
      case "current_mode_update":
        this.emit("mode", { sessionId, currentModeId: update.currentModeId });
        return;
      default:
        this.emit("session-update", value);
    }
  }

  /** 新会话：cwd 必须在授权根内；MCP 服务器声明随 session/new 交给 agent 连接。 */
  async newSession(handle: number, cwd: string, mcpServers?: unknown): Promise<unknown> {
    const resolved = this.access.resolveExisting(cwd);
    const session = this.require(handle);
    session.workspaceRoot = resolved;
    const mcp = toAcpMcpServers(mcpServers, { http: session.mcpHttp, sse: session.mcpSse });
    const response = await session.request!("session/new", {
      cwd: resolved,
      mcpServers: mcp.servers,
    });
    const value = response as { sessionId?: unknown; modes?: unknown; configOptions?: unknown };
    session.sessionId = String(value.sessionId ?? "");
    session.modes = value.modes ?? null;
    return {
      ...(response as Record<string, unknown>),
      mcpServers: mcp.declared,
      skippedMcpServers: mcp.skipped,
      imagePrompts: session.imagePrompts,
    };
  }

  /** 恢复 / 加载会话：优先 resume，失败回落 load。 */
  async loadSession(handle: number, cwd: string, sessionId: string, mcpServers?: unknown): Promise<unknown> {
    const resolved = this.access.resolveExisting(cwd);
    const session = this.require(handle);
    session.workspaceRoot = resolved;
    if (!session.loadSession && !session.resumeSession) {
      throw new Error("agent does not support session/load or session/resume");
    }
    const mcp = toAcpMcpServers(mcpServers, { http: session.mcpHttp, sse: session.mcpSse });
    const params = { cwd: resolved, mcpServers: mcp.servers };
    let resumed = false;
    const decorate = (response: unknown) => ({
      ...(response as Record<string, unknown>),
      mcpServers: mcp.declared,
      skippedMcpServers: mcp.skipped,
      imagePrompts: session.imagePrompts,
      resumed,
    });
    if (session.resumeSession) {
      try {
        const response = await session.request!("session/resume", { sessionId, ...params });
        resumed = true;
        return decorate(response);
      } catch {
        // 回落到 load。
      }
    }
    return decorate(await session.request!("session/load", { sessionId, ...params }));
  }

  /** 发送回合：注册 turnId，响应到达后广播 prompt-done（成功回合附带产物扫描）。 */
  async send(handle: number, text: string): Promise<{ turnId: number }> {
    const session = this.require(handle);
    if (!session.sessionId) throw new Error("session not created; call acp_new_session first");
    const requestId = ++session.nextId;
    const turnId = this.nextTurnId++;
    const startedMs = Date.now();
    const workspaceRoot = session.workspaceRoot;
    const pending = session.pending;
    const turns = session.turns;
    turns.set(turnId, requestId);

    // 用底层 pending 通道发请求（响应不 resolve 给调用方，走事件流）。
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
    });
    session.proc.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "session/prompt",
        params: { sessionId: session.sessionId, prompt: [{ type: "text", text }] },
      }) + "\n",
    );
    void promise
      .then(async (response) => {
        turns.delete(turnId);
        // 只对成功回合扫产物：失败 / 被取消的回合不弹（与前端「失败不假装完成」同语义）。
        // mtime 是秒级粒度：回合首秒内写的文件其秒值可能早于 startedMs 的毫秒值，
        // 下界放宽 2s 兜住粒度差。扫描失败退化为不弹，绝不把成功回合演成错误。
        let files: string[] = [];
        if (workspaceRoot) {
          try {
            files = await scanTurnArtifacts(workspaceRoot, Math.max(0, startedMs - 2_000));
          } catch {
            files = [];
          }
        }
        this.emit("prompt-done", { handle, turnId, response, files });
      })
      .catch((error) => {
        turns.delete(turnId);
        this.emit("prompt-done", { handle, turnId, error: (error as Error).message });
      });
    return { turnId };
  }

  /** 停止：turnId = 精确取消单回合；无 turnId = 会话回收（通知 + 进程树）。 */
  async stop(handle: number, turnId: number | null): Promise<void> {
    const session = this.require(handle);
    if (turnId !== null) {
      const requestId = session.turns.get(turnId);
      if (requestId === undefined) throw new Error(`unknown or finished turn ${turnId}`);
      session.turns.delete(turnId);
      if (session.sessionId) {
        session.proc.stdin?.write(
          JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: session.sessionId } }) + "\n",
        );
      }
      session.proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "$/cancel_request", params: { id: requestId } }) + "\n");
      this.releasePendingPermissions(handle);
      this.emit("turn-cancelled", { handle, turnId });
      return;
    }
    this.sessions.delete(handle);
    this.releasePendingPermissions(handle);
    if (session.sessionId) {
      session.proc.stdin?.write(
        JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: session.sessionId } }) + "\n",
      );
    }
    setTimeout(() => {
      killAgentTree(session.proc);
    }, 300);
    this.emit("stopped", { handle });
  }

  /** 旧版会话模式切换：agent 需在 new/load 时声明过 modes。 */
  async setMode(handle: number, modeId: string): Promise<unknown> {
    const session = this.require(handle);
    const sessionId = session.sessionId;
    if (!sessionId) throw new Error("session not created; call acp_new_session first");
    const modes = session.modes as { availableModes?: { id?: unknown }[] } | null;
    if (!modes || !modes.availableModes?.some((mode) => String(mode.id) === modeId)) {
      throw new Error(`unknown session mode ${modeId}`);
    }
    return session.request?.("session/set_mode", { sessionId, modeId });
  }

  /** 配置项切换：agent 需在 initialize / config_option_update 里声明过该 configId。 */
  async setConfig(handle: number, configId: string, value: unknown): Promise<unknown> {
    const session = this.require(handle);
    const sessionId = session.sessionId;
    if (!sessionId) throw new Error("session not created; call acp_new_session first");
    return session.request?.("session/set_config_option", { sessionId, configId, value });
  }

  cancelSession(handle: number, sessionId: string): void {
    const session = this.require(handle);
    session.proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }) + "\n");
  }

  /**
   * 关闭 agent 侧会话（Rust `acp_close_session` 同语义）：agent 未声明 close 能力或
   * 调用方带来的 sessionId 已过期（前端状态滞后）时返回 false 而不是报错。
   */
  async closeSession(handle: number, expectedSessionId: string | null): Promise<boolean> {
    const session = this.require(handle);
    const sessionId = session.sessionId;
    if (!sessionId) return false;
    if (expectedSessionId !== null && expectedSessionId !== sessionId) return false;
    if (!session.closeSession) return false;
    try {
      await session.request?.("session/close", { sessionId });
    } catch (error) {
      throw new Error(`session/close failed: ${(error as Error).message}`, { cause: error });
    }
    session.sessionId = undefined;
    session.workspaceRoot = null;
    session.modes = null;
    // 会话都关了，在途回合的取消句柄也不再有效；留着只会让后续 stop 打到旧请求。
    session.turns.clear();
    this.releasePendingPermissions(handle);
    this.emit("session-closed", { handle, sessionId, closed: true });
    return true;
  }

  respondPermission(requestId: number, optionId: string | null): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) throw new Error(`unknown permission request ${requestId}`);
    this.pendingPermissions.delete(requestId);
    pending.resolve(optionId);
  }

  setPermissionTier(handle: number, tier: string): void {
    const session = this.require(handle);
    session.tier = parseTier(tier);
  }

  list(): { handle: number; command: string; hasSession: boolean }[] {
    return [...this.sessions.entries()]
      .map(([handle, session]) => ({ handle, command: session.command, hasSession: session.sessionId !== undefined }))
      .sort((left, right) => left.handle - right.handle);
  }

  disposeAll(): void {
    for (const [handle, session] of [...this.sessions.entries()]) {
      session.exited = true;
      killAgentTree(session.proc);
      this.sessions.delete(handle);
      void handle;
    }
    this.pendingPermissions.clear();
  }

  private releasePendingPermissions(handle: number): void {
    // 按 handle 归属清理：pending.sessionId 匹配该 handle 的主会话（或尚无 sessionId）。
    const owned = new Set([...this.sessions.entries()].filter(([id]) => id === handle).map(([, session]) => session.sessionId));
    for (const [id, pending] of [...this.pendingPermissions.entries()]) {
      if (pending.sessionId === null || owned.has(pending.sessionId)) {
        this.pendingPermissions.delete(id);
        pending.resolve(null);
      }
    }
    void handle;
  }

  private require(handle: number): AcpSession {
    const session = this.sessions.get(handle);
    if (!session) throw new Error(`unknown handle ${handle}`);
    return session;
  }
}
