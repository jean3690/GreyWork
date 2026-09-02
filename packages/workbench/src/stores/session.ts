import { createJsonStorage } from "@greywork/core";
import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { sessionBackend } from "../lib/session-backend";
import { MOCK_THREAD_GROUPS } from "../mocks/threads";
import { MOCK_WORKSPACES } from "../mocks/workspaces";
import type { ThreadMessage } from "../types";

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

const storage = createJsonStorage<PersistedSessions>(STORAGE_KEY, isPersistedSessions);
const legacyStorage = createJsonStorage<LegacyPersistedSessions>(STORAGE_KEY, isLegacyPersistedSessions);

/** mock 线程种子 → SessionRecord（messages 由 chat 管线按需回填）。 */
const SEED_OFFSET_MS: Record<string, number> = {
  刚刚: 0,
  "2 小时前": 2 * 3600_000,
  昨天: 24 * 3600_000,
  周一: 3 * 24 * 3600_000,
  "3 天前": 3 * 24 * 3600_000,
  上周: 7 * 24 * 3600_000,
};

function seedSessions(): SessionRecord[] {
  const now = Date.now();
  const workspaceIdOf = (workspaceName: string): string | null =>
    MOCK_WORKSPACES.find((workspace) => workspace.name === workspaceName)?.id ?? null;
  return MOCK_THREAD_GROUPS.flatMap((group) =>
    group.threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      workspaceId: workspaceIdOf(group.workspace),
      createdAt: now - (SEED_OFFSET_MS[thread.time] ?? 0) - 3600_000,
      updatedAt: now - (SEED_OFFSET_MS[thread.time] ?? 0),
      messages: [] as ThreadMessage[],
    })),
  );
}

let sessionSeq = 0;
function makeId(): string {
  sessionSeq += 1;
  return `ses-${Date.now().toString(36)}-${sessionSeq}`;
}

function loadSessions(): PersistedSessions {
  const current = storage.read();
  if (current) return current;
  const legacy = legacyStorage.read();
  if (legacy) return migrateLegacySessions(legacy);
  return { version: 2, sessions: seedSessions(), activeSessionId: null };
}

/** 会话管理：桌面态真源为 SQLite（db_sessions_*），localStorage 作首帧缓存；浏览器态维持 localStorage 全量持久化。 */
export const useSessionStore = defineStore("session", () => {
  const loaded = loadSessions();
  const sessions = ref<SessionRecord[]>(loaded.sessions);
  const activeSessionId = ref<string | null>(loaded.activeSessionId);

  /* 消息内容 / 步骤状态等深层变更也落盘：debounce 500ms 合并写。 */
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  function persistSoon(): void {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist();
    }, 500);
  }
  watch(sessions, persistSoon, { deep: true });

  function persist(): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    storage.write({ version: 2, sessions: sessions.value, activeSessionId: activeSessionId.value });
    if (sessionBackend.active()) {
      // 后端真源同步：失败不回滚内存（下次 persist 自愈），仅上报。
      void sessionBackend.save({ sessions: sessions.value, activeSessionId: activeSessionId.value }).catch((error: unknown) => {
        console.error("[session] SQLite 同步失败，将下次重试", error);
      });
    }
  }

  /** 桌面态启动接管：库已接管 → 以库内容覆盖（localStorage 仅首帧缓存）；未接管 → 当前内容首落库。 */
  const backendHydratePromise = (() => {
    if (!sessionBackend.active()) return null;
    return sessionBackend
      .load()
      .then((snapshot) => {
        if (snapshot) {
          sessions.value = snapshot.sessions as SessionRecord[];
          activeSessionId.value = snapshot.activeSessionId;
        } else {
          persist(); // 首启：种子/缓存成为库的真源快照
        }
      })
      .catch((error: unknown) => {
        console.error("[session] SQLite 加载失败，沿用本地缓存", error);
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
    persist,
  };
});
