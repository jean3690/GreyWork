/**
 * 会话存储三态后端。
 *
 * - Tauri 桌面态：文件真源（`~/.greyWork/sessions` 与 `<工作区>/.greyWork/sessions`，
 *   见 Rust store_fs.rs；含 SQLite 旧库一次性迁移）；localStorage 仅首帧缓存。
 * - 浏览器态 + 配置了远端（WebDAV）：把同一套布局推到远端目录，浏览器也真落盘。
 *   差异：远端只有一个基址，**不按工作区分目录**——所有会话平铺在 `<base>/sessions/`，
 *   工作区归属仍在会话 JSON 的 workspaceId 字段里，语义不丢。
 * - 浏览器态 + 未配置远端：无后端，返回 null / no-op，store 维持 localStorage 持久化。
 *
 * 快照形状与 `PersistedSessions`（v2）同构；后端对消息负载不透明
 * （ThreadMessage 全字段 JSON 往返，Rust 侧零解析）。
 *
 * sync 是增量的：内容未变跳过，磁盘/远端版本更新则报冲突而不覆盖，删除只按显式
 * 清单执行。调用方据 `SyncReport.conflicts` 决定是否回读合并。
 */

import { invoke } from "@tauri-apps/api/core";
import { isAbsolutePath, isTauriRuntime } from "@greywork/core";
import { isRemoteStoreEnabled, readRemoteStoreConfig } from "./remote-store-config";
import { createWebdavClient } from "./webdav";

/** 与 Rust `WorkspaceDirDto` 对齐：会话按 workspaceId 归属文件夹落盘。 */
export interface WorkspaceDirRef {
  id: string;
  /** 用户自选工作区文件夹（绝对路径；未绑定 = 无此项）。 */
  folder?: string;
}

/** 单条会话（消息负载不透明，类型由调用方断言）。 */
export interface BackendConversation {
  id: string;
  title: string;
  workspaceId: string | null;
  createdAt: number;
  updatedAt: number;
  messages: unknown[];
}

export interface SessionBackendSnapshot {
  sessions: BackendConversation[];
  activeSessionId: string | null;
}

/** 一条被拒绝覆盖的会话：落盘侧版本更新。 */
export interface SyncConflict {
  id: string;
  diskUpdatedAt: number;
}

/** 与 Rust `SyncReportDto` 对齐。 */
export interface SyncReport {
  written: number;
  skipped: number;
  deleted: number;
  conflicts: SyncConflict[];
}

const EMPTY_REPORT: SyncReport = { written: 0, skipped: 0, deleted: 0, conflicts: [] };

/** 只有真正绑定磁盘路径的工作区才参与文件分目录（folder 为空串/非路径态忽略）。 */
export function toWorkspaceDirRefs(workspaces: { id: string; folder?: string }[]): WorkspaceDirRef[] {
  return workspaces
    .filter((workspace) => workspace.folder && isAbsolutePath(workspace.folder))
    .map((workspace) => ({ id: workspace.id, folder: workspace.folder }));
}

/* ===== WebDAV 后端（浏览器态） ===== */

const REMOTE_SESSIONS_DIR = "sessions";
const REMOTE_ACTIVE_FILE = "active.json";
const REMOTE_READY_MARKER = ".ready";

/**
 * 上一次由本实例写出的内容（id → payload）。
 *
 * 存在的意义是省掉 GET：内容与上次写出的一致就直接判定「未变」，只有真的变了
 * 才去远端比对冲突。没有它的话每次 debounce 都要把整个会话列表 GET 一遍。
 */
const remoteWriteCache = new Map<string, string>();

function remoteClient() {
  return createWebdavClient(readRemoteStoreConfig());
}

function parseConversation(raw: string): BackendConversation | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!("id" in parsed) || typeof parsed.id !== "string") return null;
    if (!("updatedAt" in parsed) || typeof parsed.updatedAt !== "number") return null;
    // 已校验身份字段（id/updatedAt）；messages 与桌面面一样保持不透明，不逐条解析
    return parsed as BackendConversation;
  } catch {
    return null;
  }
}

async function remoteLoad(): Promise<SessionBackendSnapshot | null> {
  const client = remoteClient();
  // 未接管：与桌面态同一语义——前端以本地缓存/种子为真源并回写
  if ((await client.getText(REMOTE_READY_MARKER)) === null) return null;
  const names = await client.list(REMOTE_SESSIONS_DIR);
  const sessions: BackendConversation[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const raw = await client.getText(`${REMOTE_SESSIONS_DIR}/${name}`);
    if (!raw) continue;
    const session = parseConversation(raw);
    if (!session) continue;
    remoteWriteCache.set(session.id, raw);
    sessions.push(session);
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  const activeRaw = await client.getText(REMOTE_ACTIVE_FILE);
  let activeSessionId: string | null = null;
  if (activeRaw) {
    try {
      const parsed: unknown = JSON.parse(activeRaw);
      if (typeof parsed === "object" && parsed !== null && "activeSessionId" in parsed && typeof parsed.activeSessionId === "string") {
        activeSessionId = parsed.activeSessionId;
      }
    } catch {
      activeSessionId = null; // 损坏的 active.json 不该拖垮整次加载
    }
  }
  return { sessions, activeSessionId };
}

async function remoteSave(snapshot: SessionBackendSnapshot, deletedSessionIds: string[]): Promise<SyncReport> {
  const client = remoteClient();
  await client.ensureDir(REMOTE_SESSIONS_DIR);
  const report: SyncReport = { written: 0, skipped: 0, deleted: 0, conflicts: [] };

  for (const session of snapshot.sessions) {
    const payload = JSON.stringify(session);
    const path = `${REMOTE_SESSIONS_DIR}/${session.id}.json`;
    if (remoteWriteCache.get(session.id) === payload) {
      report.skipped += 1;
      continue;
    }
    const existing = await client.getText(path);
    if (existing === payload) {
      remoteWriteCache.set(session.id, payload);
      report.skipped += 1;
      continue;
    }
    if (existing) {
      const diskUpdatedAt = parseConversation(existing)?.updatedAt ?? null;
      if (diskUpdatedAt !== null && diskUpdatedAt > session.updatedAt) {
        report.conflicts.push({ id: session.id, diskUpdatedAt });
        continue;
      }
    }
    await client.putText(path, payload);
    remoteWriteCache.set(session.id, payload);
    report.written += 1;
  }

  for (const id of deletedSessionIds) {
    await client.del(`${REMOTE_SESSIONS_DIR}/${id}.json`);
    remoteWriteCache.delete(id);
    report.deleted += 1;
  }

  await client.putText(REMOTE_ACTIVE_FILE, JSON.stringify({ activeSessionId: snapshot.activeSessionId }));
  await client.putText(REMOTE_READY_MARKER, "1");
  return report;
}

/* ===== 统一后端面 ===== */

export const sessionBackend = {
  /** 当前运行时是否有落盘真源（Tauri 桌面，或浏览器态配好了远端）。 */
  active(): boolean {
    return isTauriRuntime() || isRemoteStoreEnabled(readRemoteStoreConfig());
  },

  /** 落盘侧是否按工作区分目录（只有桌面文件面才有这个概念；搬迁命令据此决定是否可用）。 */
  hasWorkspaceDirs(): boolean {
    return isTauriRuntime();
  },

  /**
   * 读快照。未接管（`.ready` 不存在且旧库未初始化）时返回 null，
   * store 以本地内容为真源回填并触发首次 sync。
   */
  async load(workspaces: WorkspaceDirRef[]): Promise<SessionBackendSnapshot | null> {
    if (isTauriRuntime()) {
      return invoke<SessionBackendSnapshot | null>("store_sessions_load", { workspaces });
    }
    if (!isRemoteStoreEnabled(readRemoteStoreConfig())) return null;
    return remoteLoad();
  },

  /** 增量同步；`deletedSessionIds` 是本次要落实的删除清单（落盘侧只删它）。 */
  async save(snapshot: SessionBackendSnapshot, workspaces: WorkspaceDirRef[], deletedSessionIds: string[] = []): Promise<SyncReport> {
    if (isTauriRuntime()) {
      // 旧版宿主的 store_sessions_sync 无返回值（null）：归一化成空报告，
      // 免得新前端 + 旧二进制的组合在读 conflicts 时炸掉。
      const report = await invoke<SyncReport | null>("store_sessions_sync", { snapshot, workspaces, deletedSessionIds });
      return report ?? EMPTY_REPORT;
    }
    if (!isRemoteStoreEnabled(readRemoteStoreConfig())) return EMPTY_REPORT;
    return remoteSave(snapshot, deletedSessionIds);
  },
};
