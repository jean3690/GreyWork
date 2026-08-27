import type { SessionManager, SessionMeta } from "./types";

export function createMemorySessionManager(seed: string[] = []): SessionManager {
  const sessions = new Map<string, SessionMeta>();
  for (const title of seed) {
    const session = makeSession(title);
    sessions.set(session.id, session);
  }

  return {
    createSession(title = "未命名会话") {
      const session = makeSession(title);
      sessions.set(session.id, session);
      return session;
    },
    getSession(id) {
      return sessions.get(id);
    },
    listSessions() {
      return Array.from(sessions.values());
    },
    touchSession(id) {
      const session = sessions.get(id);
      if (session) {
        session.updatedAt = new Date().toISOString();
      }
    },
    closeSession(id) {
      return sessions.delete(id);
    },
    setView(id, view) {
      const session = sessions.get(id);
      if (session) session.activeView = view;
    },
    attachPlugin(id, pluginId) {
      const session = sessions.get(id);
      if (session && !session.pluginIds.includes(pluginId)) {
        session.pluginIds.push(pluginId);
      }
    },
  };
}

function makeSession(title: string): SessionMeta {
  const now = new Date().toISOString();
  return {
    id: `ses-${Math.random().toString(36).slice(2, 10)}`,
    title,
    createdAt: now,
    updatedAt: now,
    activeView: "overview",
    pluginIds: [],
  };
}
