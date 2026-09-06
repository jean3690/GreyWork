import { createJsonStorage } from "@greywork/core";
import { defineStore } from "pinia";
import { ref } from "vue";
import { sessionBackend } from "../lib/session-backend";
import { notify } from "./notice";
import { i18n } from "../i18n";

const t = i18n.global.t;
import { toWorkspaceDirRefs } from "../lib/session-backend";
import { useWorkspaceStore } from "./workspace";
import type { MessageSegment, ThreadMessage } from "../types";

/** 会话记录：一条会话 = 一组对话消息 + 归属工作区 + 时间戳。 */
export interface SessionRecord {
  id: string;
  title: string;
  /** 归属工作区 id；null = 普通对话（未绑定工作区）。 */
  workspaceId: string | null;
  createdAt: number;
  updatedAt: number;
  messages: ThreadMessage[];
}

const STORAGE_KEY = "greywork.sessions";
const DEFAULT_TITLE = "新对话";

/** v2：workspaceId 绑定；v1（项目时代）为 projectId，读取时迁移。 */
interface PersistedSessions {
  version: 2;
  sessions: SessionRecord[];
  activeSessionId: string | null;
}

interface LegacySession {
  id: string;
  title: string;
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
  messages: ThreadMessage[];
}

interface LegacyPersistedSessions {
  version: 1;
  sessions: LegacySession[];
  activeSessionId: string | null;
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    (record.workspaceId === null || typeof record.workspaceId === "string") &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number" &&
    Array.isArray(record.messages)
  );
}

function isPersistedSessions(value: unknown): value is PersistedSessions {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 2 &&
    Array.isArray(record.sessions) &&
    record.sessions.every(isSessionRecord) &&
    (record.activeSessionId === null || typeof record.activeSessionId === "string")
  );
}

function isLegacyPersistedSessions(value: unknown): value is LegacyPersistedSessions {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    Array.isArray(record.sessions) &&
    (record.activeSessionId === null || typeof record.activeSessionId === "string")
  );
}

/** v1（项目绑定）→ v2（工作区绑定）：projectId 直接改名为 workspaceId。 */
function migrateLegacySessions(value: LegacyPersistedSessions): PersistedSessions {
  return {
    version: 2,
    sessions: value.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      workspaceId: session.projectId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages,
    })),
    activeSessionId: value.activeSessionId,
  };
}

/**
 * 采纳外部消息档：历史消息把思考存在 `thinking` 平铺字段上，没有段落表。
 * 旧档的真实到达顺序已无从还原，按当年的渲染顺序（思考 → 工具 → 正文）重建为段落，
 * 这样渲染层只有一条路径，不必为老数据保留第二套分支。
 */
function adoptMessages(messages: ThreadMessage[]): ThreadMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || (message.segments && message.segments.length > 0)) return message;
    // 旧字段已从 ThreadMessage 移除，这里只为迁移读一次
    const legacy = message as ThreadMessage & { thinking?: string; thinkingAt?: number; thinkingFor?: number };
    const segments: MessageSegment[] = [];
    if (typeof legacy.thinking === "string" && legacy.thinking) {
      const startedAt = legacy.thinkingAt ?? message.ts;
      segments.push({
        kind: "thinking",
        id: `${message.id}-s-think`,
        text: legacy.thinking,
        startedAt,
        endedAt: startedAt + (legacy.thinkingFor ?? 0),
      });
    }
    if (message.tools && message.tools.length > 0) {
      segments.push({ kind: "tools", id: `${message.id}-s-tools`, toolCallIds: message.tools.map((activity) => activity.toolCallId) });
    }
    if (message.content) segments.push({ kind: "text", id: `${message.id}-s-text`, from: 0, to: null });
    return segments.length > 0 ? { ...message, segments } : message;
  });
}

/** 采纳外部会话档：逐条消息做段落归一。 */
function adoptSessions(records: SessionRecord[]): SessionRecord[] {
  for (const record of records) record.messages = adoptMessages(record.messages);
  return records;
}

const storage = createJsonStorage<PersistedSessions>(STORAGE_KEY, isPersistedSessions);
const legacyStorage = createJsonStorage<LegacyPersistedSessions>(STORAGE_KEY, isLegacyPersistedSessions);

/**
 * 首启无任何缓存时从空会话列表开始。
 *
 * 早期版本在这里灌入 mock 线程种子，让侧栏看起来有「历史」——但那是对用户的欺骗：
 * 全新安装第一帧就在真库里出现 6 条从未发生过的会话（随后还会被当作真源落盘）。
 * 演示数据请走 dev-only 注入（import.meta.env.DEV 守卫），不进首启默认路径。
 */
let sessionSeq = 0;
function makeId(): string {
  sessionSeq += 1;
  return `ses-${Date.now().toString(36)}-${sessionSeq}`;
}

function loadSessions(): PersistedSessions {
  const current = storage.read();
  if (current) return { ...current, sessions: adoptSessions(current.sessions) };
  const legacy = legacyStorage.read();
  if (legacy) {
    const migrated = migrateLegacySessions(legacy);
    return { ...migrated, sessions: adoptSessions(migrated.sessions) };
  }
  return { version: 2, sessions: [], activeSessionId: null };
}

/** 会话管理：桌面态真源为会话文件（store_fs），浏览器态可配远端（WebDAV）；localStorage 作首帧缓存。 */
export const useSessionStore = defineStore("session", () => {
  const loaded = loadSessions();
  const sessions = ref<SessionRecord[]>(loaded.sessions);
  const activeSessionId = ref<string | null>(loaded.activeSessionId);

  /* 工作区目录清单：会话文件按归属落到 ~/.greyWork/sessions 或 <工作区>/.greyWork/sessions。 */
  const workspaceStore = useWorkspaceStore();
  const workspaceDirs = () => toWorkspaceDirRefs(workspaceStore.workspaces);

  /* 深层就地修改（消息内容 / 段落 / 步骤 / 工具时间线）也落盘：写入方改完显式
     markDirty()，debounce 500ms 合并写。不再 deep watch 整棵 sessions 树 ——
     流式管线每 ~40ms flush 一次就触发一次全树深度遍历（所有会话 × 消息 × 段落），
     token 密集时纯属浪费；store action 本来就各自 persist()，只有绕过 action 的
     就地写入才需要打脏，写入方是有限的几个（都在 chat.ts 的段落助手函数里）。 */
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  function persistSoon(): void {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist();
    }, 500);
  }
  /** 深层就地修改后的统一打脏入口：直接改会话树内容（而非调用 store action）的代码必须调用它。 */
  function markDirty(): void {
    persistSoon();
  }

  /**
   * 待落实的删除清单。
   *
   * 落盘侧不再扫目录清扫「不在快照里的文件」（多实例会互删），删除必须显式送达。
   * 同步成功才清空：失败就留到下次 persist 重试，避免删除动作被吞掉。
   */
  const pendingDeletions = new Set<string>();

  /**
   * 落盘侧版本更新导致的冲突：按 id 回读并取较新者。
   *
   * 只动冲突的那几条，不整表替换 —— 整表替换会把本实例尚未落盘的其它会话编辑冲掉。
   */
  async function reconcileConflicts(conflicts: { id: string }[]): Promise<void> {
    const ids = conflicts.map((conflict) => conflict.id);
    console.warn("[session] 落盘侧有更新版本，按条合并", ids);
    const snapshot = await sessionBackend.load(workspaceDirs());
    if (!snapshot) return;
    for (const record of adoptSessions(snapshot.sessions as SessionRecord[])) {
      if (!ids.includes(record.id)) continue;
      const index = sessions.value.findIndex((candidate) => candidate.id === record.id);
      if (index < 0) sessions.value.push(record);
      else if (record.updatedAt > sessions.value[index]!.updatedAt) sessions.value[index] = record;
    }
  }

  function persist(): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    storage.write({ version: 2, sessions: sessions.value, activeSessionId: activeSessionId.value });
    if (!sessionBackend.active()) return;
    const deleted = [...pendingDeletions];
    // 后端真源同步：失败不回滚内存（下次 persist 自愈），仅上报。
    void sessionBackend
      .save({ sessions: sessions.value, activeSessionId: activeSessionId.value }, workspaceDirs(), deleted)
      .then(async (report) => {
        for (const id of deleted) pendingDeletions.delete(id);
        if (report.conflicts.length) await reconcileConflicts(report.conflicts);
      })
      .catch((error: unknown) => {
        console.error("[session] 落盘同步失败，将下次重试", error);
        notify({ kind: "error", key: "session-sync", title: t("errors.sessionSyncFailed"), detail: String(error) });
      });
  }

  /** 启动接管：落盘侧已接管 → 以其内容覆盖（localStorage 仅首帧缓存）；未接管 → 当前内容首落盘。 */
  const backendHydratePromise = (() => {
    if (!sessionBackend.active()) return null;
    return sessionBackend
      .load(workspaceDirs())
      .then((snapshot) => {
        if (snapshot) {
          sessions.value = adoptSessions(snapshot.sessions as SessionRecord[]);
          activeSessionId.value = snapshot.activeSessionId;
        } else {
          persist(); // 首启：种子/缓存成为库的真源快照
        }
      })
      .catch((error: unknown) => {
        console.error("[session] 落盘加载失败，沿用本地缓存", error);
        notify({ kind: "warning", key: "session-load", title: t("errors.sessionLoadFailed"), detail: String(error) });
      });
  })();

  function getSession(id: string): SessionRecord | undefined {
    return sessions.value.find((candidate) => candidate.id === id);
  }

  /** 新建会话并置为当前；title 缺省「新对话」。 */
  function createSession(workspaceId: string | null, title: string = DEFAULT_TITLE): SessionRecord {
    const now = Date.now();
    const session: SessionRecord = { id: makeId(), title, workspaceId, createdAt: now, updatedAt: now, messages: [] };
    sessions.value.unshift(session);
    activeSessionId.value = session.id;
    persist();
    return session;
  }

  /** ensure：缺 id 时创建空会话并返回其消息列表（UI 切历史线程 / 测试直连套用）。 */
  function ensure(id: string): ThreadMessage[] {
    const existing = getSession(id);
    if (existing) return existing.messages;
    const now = Date.now();
    const session: SessionRecord = {
      id,
      title: DEFAULT_TITLE,
      workspaceId: null,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    sessions.value.unshift(session);
    activeSessionId.value = id;
    persist();
    return getSession(id)?.messages ?? session.messages;
  }

  function renameSession(id: string, title: string): void {
    const session = getSession(id);
    const trimmed = title.trim();
    if (!session || !trimmed) return;
    session.title = trimmed;
    touch(id);
    persist();
  }

  /**
   * 首条用户消息自动命名：只在标题仍是默认值时写入，用户手动改过名就不再动
   *（否则第二句会把用户起的名字冲掉）。
   */
  function autoTitle(id: string, text: string): void {
    const session = getSession(id);
    if (!session || session.title !== DEFAULT_TITLE) return;
    const flat = text.trim().replace(/\s+/g, " ");
    if (!flat) return;
    session.title = flat.length > 24 ? `${flat.slice(0, 24)}…` : flat;
  }

  function deleteSession(id: string): void {
    const index = sessions.value.findIndex((candidate) => candidate.id === id);
    if (index < 0) return;
    sessions.value.splice(index, 1);
    // 落盘侧只删显式清单里的文件，这里不登记就会留下孤儿会话文件
    pendingDeletions.add(id);
    if (activeSessionId.value === id) activeSessionId.value = null;
    persist();
  }

  function touch(id: string): void {
    const session = getSession(id);
    if (session) session.updatedAt = Date.now();
  }

  function setActive(id: string | null): void {
    activeSessionId.value = id;
    persist();
  }

  function appendMessage(id: string, message: ThreadMessage): void {
    ensure(id).push(message);
    touch(id);
    // 会话标题跟着第一条用户消息走；助手消息不参与命名。
    if (message.role === "user") autoTitle(id, message.content);
    persist();
  }

  /** 工作区删除后把其会话迁移到「普通对话」（不连带删除用户对话历史）。 */
  function reassignWorkspace(fromWorkspaceId: string, toWorkspaceId: string | null): void {
    let changed = false;
    for (const session of sessions.value) {
      if (session.workspaceId === fromWorkspaceId) {
        session.workspaceId = toWorkspaceId;
        changed = true;
      }
    }
    if (changed) persist();
  }

  /** 归属工作区的会话（按更新时间倒序）。 */
  function sessionsOf(workspaceId: string | null): SessionRecord[] {
    return sessions.value.filter((session) => session.workspaceId === workspaceId).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return {
    sessions,
    activeSessionId,
    /** 桌面态启动接管完成信号（null = 浏览器态无后端）；await 后库内容已就位。 */
    hydrated: backendHydratePromise,
    getSession,
    createSession,
    ensure,
    renameSession,
    autoTitle,
    deleteSession,
    touch,
    setActive,
    appendMessage,
    reassignWorkspace,
    sessionsOf,
    /** 深层就地修改后打脏，500ms 防抖合并落盘（替代曾经的 deep watch）。 */
    markDirty,
    persist,
  };
});
