/**
 * 会话存储（文件面）：移植 `crates/greywork-host/src/infra/store_fs/`。
 *
 * 布局：默认 `~/.greyWork/sessions/<id>.json`，绑定工作区的会话落在
 * `<folder>/.greyWork/sessions/`；`active.json` 记活动会话，`.ready` 标记「文件面已接管」
 * （空快照也代表用户清空，不能复活种子）。跨进程互斥用「建目录」这个原子动作，30s 未释放
 * 判陈旧，RAII 释放。
 *
 * 写入规则（与 Rust 一致，防多实例互踩）：内容相同 → skipped；磁盘版本更新 → conflicts 且
 * 不写；只删调用方显式列出的 id，绝不扫目录清扫。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { WorkspaceAccess } from "./workspace-access.js";

const SESSIONS_SUB_DIR = "sessions";
const GREY_WORK_DIR = ".greyWork";
const READY_MARKER = ".ready";
const ACTIVE_FILE = "active.json";
const ATTACHMENTS_SUB_DIR = "attachments";
const LOCK_DIR = ".lock";
const LOCK_OWNER_FILE = "owner.json";
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_RETRY_LIMIT = 40;

export interface WorkspaceDir {
  id: string;
  folder: string | null;
}

export interface SessionConflict {
  id: string;
  diskUpdatedAt: number;
}

export interface SyncReport {
  written: number;
  skipped: number;
  deleted: number;
  conflicts: SessionConflict[];
}

export interface SessionSnapshot {
  sessions: unknown[];
  activeSessionId: string | null;
}

/** 跨进程存储锁：建目录作为原子加锁，owner.json 只用于陈旧判定。 */
class StoreLock {
  private constructor(private readonly dir: string) {}

  static acquire(root: string): StoreLock {
    const dir = path.join(root, LOCK_DIR);
    for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
      try {
        mkdirSync(dir);
        try {
          writeFileSync(path.join(dir, LOCK_OWNER_FILE), JSON.stringify({ pid: process.pid, at: Date.now() }));
        } catch {
          // owner 写失败只影响陈旧判定精度，锁已到手。
        }
        return new StoreLock(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new Error(`获取会话存储锁失败: ${(error as Error).message}`, { cause: error });
        }
        if (StoreLock.isStale(dir)) {
          rmSync(dir, { recursive: true, force: true });
          continue;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_DELAY_MS);
      }
    }
    throw new Error("会话存储锁被其它实例长期占用，本次同步放弃");
  }

  private static isStale(dir: string): boolean {
    try {
      const owner = JSON.parse(readFileSync(path.join(dir, LOCK_OWNER_FILE), "utf8")) as { at?: unknown };
      if (typeof owner.at === "number") return Date.now() - owner.at > LOCK_STALE_MS;
    } catch {
      // 文件还没写出 / 已损坏：退回目录 mtime。
    }
    try {
      return Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }

  release(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 会话 id → 安全文件名（仅保留字母数字与 -/_，杜绝路径穿越）。 */
function safeFileName(id: string): string {
  return [...id].map((ch) => (/[A-Za-z0-9_-]/.test(ch) ? ch : "_")).join("");
}

function sessionPath(dir: string, id: string): string {
  return path.join(dir, `${safeFileName(id)}.json`);
}

function isFilesystemRoot(target: string): boolean {
  return path.parse(target).root === target;
}

function validateFolder(folder: string): string {
  if (!path.isAbsolute(folder)) throw new Error("工作区文件夹必须是绝对路径");
  let stat;
  try {
    stat = statSync(folder);
  } catch (error) {
    throw new Error(`工作区文件夹不可访问: ${(error as Error).message}`, { cause: error });
  }
  if (!stat.isDirectory()) throw new Error("工作区文件夹不是目录");
  if (isFilesystemRoot(folder)) throw new Error("不允许把根目录作为工作区");
  return folder;
}

function validateAuthorizedWorkspaces(access: WorkspaceAccess, workspaces: WorkspaceDir[]): void {
  for (const workspace of workspaces) {
    const folder = workspace.folder?.trim();
    if (!folder) continue;
    const resolved = access.resolveExisting(folder);
    if (!statSync(resolved).isDirectory()) throw new Error("工作区授权路径不是目录");
  }
}

function sessionDirForFolder(root: string, folder: string | null | undefined): string {
  const dir = folder ? path.join(validateFolder(folder), GREY_WORK_DIR, SESSIONS_SUB_DIR) : path.join(root, SESSIONS_SUB_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionDirFor(root: string, workspaces: WorkspaceDir[], workspaceId: string | null | undefined): string {
  const bound = workspaceId ? workspaces.find((workspace) => workspace.id === workspaceId) : undefined;
  return sessionDirForFolder(root, bound?.folder ?? null);
}

/** 快照涉及的全部会话目录（默认目录 + 各绑定工作区；去重、跳过失效目录）。 */
function allSessionDirs(root: string, workspaces: WorkspaceDir[]): string[] {
  const dirs = [sessionDirForFolder(root, null)];
  for (const workspace of workspaces) {
    if (!workspace.folder) continue;
    try {
      const dir = sessionDirFor(root, workspaces, workspace.id);
      if (!dirs.some((seen) => path.resolve(seen) === path.resolve(dir))) dirs.push(dir);
    } catch {
      // 目录失效（被删 / 改名）：跳过，不阻塞整次操作。
    }
  }
  return dirs;
}

function diskUpdatedAt(raw: string): number | null {
  try {
    const value = JSON.parse(stripBom(raw)) as { updatedAt?: unknown };
    return typeof value.updatedAt === "number" ? value.updatedAt : null;
  } catch {
    return null;
  }
}

function readActive(root: string): string | null {
  try {
    const value = JSON.parse(readFileSync(path.join(root, ACTIVE_FILE), "utf8")) as { activeSessionId?: unknown };
    return typeof value.activeSessionId === "string" ? value.activeSessionId : null;
  } catch {
    return null;
  }
}

function writeActive(root: string, active: string | null): void {
  writeFileSync(path.join(root, ACTIVE_FILE), JSON.stringify({ activeSessionId: active }));
}

function isReady(root: string): boolean {
  return existsSync(path.join(root, READY_MARKER));
}

function markReady(root: string): void {
  writeFileSync(path.join(root, READY_MARKER), "1");
}

/** 会话 id 是否安全（附件目录用：只认纯 id）。 */
function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

interface SessionShape {
  id: string;
  title: string;
  workspaceId: string | null;
  createdAt: number;
  updatedAt: number;
  messages: unknown[];
}

/** 会话对象形状校验：与 `ConversationDto` 的必填字段一致（缺字段直接报错，不静默补默认值）。 */
function validateSession(session: unknown): SessionShape {
  const value = session as Partial<SessionShape> | null;
  if (!value || typeof value.id !== "string") throw new Error("命令参数解析失败: missing field `id`");
  if (typeof value.title !== "string") throw new Error("命令参数解析失败: missing field `title`");
  if (typeof value.createdAt !== "number") throw new Error("命令参数解析失败: missing field `createdAt`");
  if (typeof value.updatedAt !== "number") throw new Error("命令参数解析失败: missing field `updatedAt`");
  if (!Array.isArray(value.messages)) throw new Error("命令参数解析失败: missing field `messages`");
  if (value.workspaceId !== undefined && value.workspaceId !== null && typeof value.workspaceId !== "string") {
    throw new Error("命令参数解析失败: invalid type for `workspaceId`");
  }
  return {
    id: value.id,
    title: value.title,
    workspaceId: value.workspaceId ?? null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    messages: value.messages,
  };
}

export class SessionFileStore {
  constructor(private readonly access: WorkspaceAccess) {}

  private get root(): string {
    return this.access.root;
  }

  /** 读全量快照；文件面未接管 → null。 */
  load(workspaces: WorkspaceDir[]): SessionSnapshot | null {
    validateAuthorizedWorkspaces(this.access, workspaces);
    const lock = StoreLock.acquire(this.root);
    try {
      if (!isReady(this.root)) return null;
      const sessions: unknown[] = [];
      for (const dir of allSessionDirs(this.root, workspaces)) {
        for (const entry of readdirSync(dir)) {
          if (!entry.endsWith(".json")) continue;
          const file = path.join(dir, entry);
          if (!statSync(file).isFile()) continue;
          const id = entry.slice(0, -5);
          let parsed: unknown;
          try {
            parsed = JSON.parse(stripBom(readFileSync(file, "utf8")));
          } catch (error) {
            throw new Error(`解析会话 ${id} 失败: ${(error as Error).message}`, { cause: error });
          }
          sessions.push(validateSession(parsed));
        }
      }
      sessions.sort((left, right) => {
        const a = (left as { updatedAt?: number }).updatedAt ?? 0;
        const b = (right as { updatedAt?: number }).updatedAt ?? 0;
        return b - a;
      });
      return { sessions, activeSessionId: readActive(this.root) };
    } finally {
      lock.release();
    }
  }

  /** 增量同步：写归属目录、只删显式列出的 id。 */
  sync(snapshot: SessionSnapshot, workspaces: WorkspaceDir[], deleted: string[]): SyncReport {
    validateAuthorizedWorkspaces(this.access, workspaces);
    const lock = StoreLock.acquire(this.root);
    try {
      const report: SyncReport = { written: 0, skipped: 0, deleted: 0, conflicts: [] };
      for (const session of snapshot.sessions) {
        const value = validateSession(session);
        const dir = sessionDirFor(this.root, workspaces, typeof value.workspaceId === "string" ? value.workspaceId : null);
        const file = sessionPath(dir, value.id);
        // 按校验后的字段序列化（与 Rust 的 ConversationDto 一致：未知字段被丢弃、顺序稳定）。
        const payload = JSON.stringify(value);
        let existing: string | null = null;
        try {
          existing = readFileSync(file, "utf8");
        } catch {
          existing = null;
        }
        if (existing === payload) {
          report.skipped += 1;
          continue;
        }
        if (existing !== null && typeof value.updatedAt === "number") {
          const diskAt = diskUpdatedAt(existing);
          if (diskAt !== null && diskAt > value.updatedAt) {
            report.conflicts.push({ id: value.id, diskUpdatedAt: diskAt });
            continue;
          }
        }
        writeFileSync(file, payload);
        report.written += 1;
      }
      if (deleted.length > 0) {
        for (const dir of allSessionDirs(this.root, workspaces)) {
          for (const id of deleted) {
            try {
              rmSync(sessionPath(dir, id));
              report.deleted += 1;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                // 单个文件删不掉（Windows 上被占用）不该让整轮同步失败。
                console.warn(`[host-node] 删除会话文件失败（已跳过）: ${(error as Error).message}`);
              }
            }
          }
        }
      }
      writeActive(this.root, snapshot.activeSessionId);
      markReady(this.root);
      return report;
    } finally {
      lock.release();
    }
  }

  /** 删除某会话的附件目录（幂等）。 */
  pruneAttachments(sessionId: string): void {
    if (!isSafeSessionId(sessionId)) throw new Error(`非法会话 id: ${sessionId}`);
    rmSync(path.join(this.root, ATTACHMENTS_SUB_DIR, sessionId), { recursive: true, force: true });
  }

  /**
   * 工作区改绑文件夹后把既有会话文件搬到新目录（Rust `store_sessions_relocate` 同语义）。
   * 归一化比较避免「同一目录不同写法」自我搬迁；目标侧版本更新视为冲突两边保留。
   */
  relocate(request: { sessionIds: string[]; fromFolder?: string | null; toFolder?: string | null }): RelocateReport {
    const authorizedFolder = (folder: string | null | undefined): void => {
      if (!folder) return;
      const resolved = this.access.resolveExisting(folder);
      if (!statSync(resolved).isDirectory()) throw new Error("工作区授权路径不是目录");
    };
    authorizedFolder(request.fromFolder);
    authorizedFolder(request.toFolder);
    const lock = StoreLock.acquire(this.root);
    try {
      const from = sessionDirForFolder(this.root, request.fromFolder ?? null);
      const to = sessionDirForFolder(this.root, request.toFolder ?? null);
      const report: RelocateReport = { moved: 0, missing: [], conflicts: [] };
      if (path.resolve(from) === path.resolve(to)) return report;
      for (const id of request.sessionIds) {
        const source = sessionPath(from, id);
        let payload: string;
        try {
          payload = readFileSync(source, "utf8");
        } catch {
          report.missing.push(id);
          continue;
        }
        const target = sessionPath(to, id);
        let existing: string | null = null;
        try {
          existing = readFileSync(target, "utf8");
        } catch {
          existing = null;
        }
        if (existing !== null) {
          const sourceAt = diskUpdatedAt(payload);
          const targetAt = diskUpdatedAt(existing);
          // 目标存在但无法判定新旧：保守视为冲突，不动任何一边。
          const newer = targetAt !== null && sourceAt !== null ? targetAt > sourceAt : true;
          if (newer) {
            report.conflicts.push(id);
            continue;
          }
        }
        try {
          renameSync(source, target);
        } catch {
          // 同分区 rename 失败（跨设备/被占用）回落读写 + 删源：
          // 目标已写好而源删不掉只是留一份冗余，不该判为失败。
          try {
            writeFileSync(target, payload);
          } catch (error) {
            throw new Error(`搬迁会话 ${id} 失败: ${(error as Error).message}`, { cause: error });
          }
          try {
            rmSync(source);
          } catch {
            // 已保留源文件，可接受。
          }
        }
        report.moved += 1;
      }
      return report;
    } finally {
      lock.release();
    }
  }
}

export interface RelocateReport {
  moved: number;
  missing: string[];
  conflicts: string[];
}
