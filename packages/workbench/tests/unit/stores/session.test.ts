// 会话存储契约：CRUD / 归属项目 / 持久化往返 / 项目删除迁移。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const h = vi.hoisted(() => ({ pruneAttachmentLibrary: vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()) }));

vi.mock("@/state/attachment-library", () => ({
  pruneAttachmentLibrary: (id: string) => h.pruneAttachmentLibrary(id),
}));

import { useSessionStore } from "@/stores/session";
import type { Attachment } from "@/types";

const storageHolder = globalThis as { localStorage?: Storage };

/** node 环境注入内存 localStorage（createJsonStorage 优先 window，再 globalThis）。 */
function injectStorage(): void {
  const backing: Record<string, string> = {};
  storageHolder.localStorage = {
    getItem: (key: string) => backing[key] ?? null,
    setItem: (key: string, value: string) => {
      backing[key] = value;
    },
    removeItem: (key: string) => {
      delete backing[key];
    },
    clear: () => {
      for (const key of Object.keys(backing)) delete backing[key];
    },
    key: (index: number) => Object.keys(backing)[index] ?? null,
    get length() {
      return Object.keys(backing).length;
    },
  } as Storage;
}

beforeEach(() => {
  setActivePinia(createPinia());
  h.pruneAttachmentLibrary.mockClear();
});

describe("基础 CRUD", () => {
  it("无持久化数据时从空会话列表开始（首启不伪造历史）", () => {
    const store = useSessionStore();
    expect(store.sessions).toHaveLength(0);
    expect(store.activeSessionId).toBeNull();
  });

  it("createSession 建会话并置为当前", () => {
    const store = useSessionStore();
    const session = store.createSession("p-city", "台风复盘");
    expect(session.id).toBeTruthy();
    expect(store.activeSessionId).toBe(session.id);
    expect(store.getSession(session.id)?.workspaceId).toBe("p-city");
  });

  it("deleteSession 同时请求清理该会话的附件目录", () => {
    const store = useSessionStore();
    const session = store.createSession(null, "带附件的会话");
    store.deleteSession(session.id);
    expect(store.getSession(session.id)).toBeUndefined();
    expect(h.pruneAttachmentLibrary).toHaveBeenCalledWith(session.id);
  });

  it("deleteSession 对不存在的 id 不做任何事（不误删附件）", () => {
    const store = useSessionStore();
    store.deleteSession("ses-not-there");
    expect(h.pruneAttachmentLibrary).not.toHaveBeenCalled();
  });

  it("ensure 复用已有会话，缺 id 时按给定 id 创建", () => {
    const store = useSessionStore();
    const created = store.createSession(null);
    const messages = store.ensure(created.id);
    expect(messages).toBe(store.getSession(created.id)?.messages);

    const list = store.ensure("ses-unknown");
    expect(store.getSession("ses-unknown")?.messages).toBe(list);
    expect(store.activeSessionId).toBe("ses-unknown");
  });

  it("appendMessage 追加并推进 updatedAt", () => {
    const store = useSessionStore();
    const session = store.createSession(null);
    const before = store.getSession(session.id)?.updatedAt ?? 0;
    store.appendMessage(session.id, { id: "m-1", role: "user", content: "hi", ts: Date.now() });
    const record = store.getSession(session.id);
    expect(record?.messages).toHaveLength(1);
    expect(record?.messages[0]?.content).toBe("hi");
    expect(record?.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("renameSession 校验空标题；deleteSession 清空激活态", () => {
    const store = useSessionStore();
    const session = store.createSession(null);
    store.renameSession(session.id, "  重命名后  ");
    expect(store.getSession(session.id)?.title).toBe("重命名后");
    store.renameSession(session.id, "   ");
    expect(store.getSession(session.id)?.title).toBe("重命名后");

    store.deleteSession(session.id);
    expect(store.getSession(session.id)).toBeUndefined();
    expect(store.activeSessionId).toBeNull();
  });

  it("首条用户消息自动命名，且后续不覆盖手动重命名", () => {
    const store = useSessionStore();
    const session = store.createSession(null);
    store.appendMessage(session.id, { id: "m-1", role: "user", content: "  整理本周\n改动  ", ts: Date.now() });
    expect(store.getSession(session.id)?.title).toBe("整理本周 改动");

    store.renameSession(session.id, "我的名字");
    store.appendMessage(session.id, { id: "m-2", role: "user", content: "第二句", ts: Date.now() });
    expect(store.getSession(session.id)?.title).toBe("我的名字");
  });

  it("助手消息不参与命名；超长输入截断", () => {
    const store = useSessionStore();
    const session = store.createSession(null);
    store.appendMessage(session.id, { id: "a-1", role: "assistant", content: "好的", ts: Date.now() });
    expect(store.getSession(session.id)?.title).toBe("新对话");

    store.appendMessage(session.id, { id: "m-1", role: "user", content: "一".repeat(40), ts: Date.now() });
    const title = store.getSession(session.id)?.title ?? "";
    expect(title).toHaveLength(25); // 24 字 + 省略号
    expect(title.endsWith("…")).toBe(true);
  });

  it("sessionsOf 按更新倒序且过滤归属", () => {
    vi.useFakeTimers();
    try {
      const store = useSessionStore();
      const first = store.createSession("p-city", "a");
      vi.advanceTimersByTime(1000);
      store.createSession("p-city", "b");
      const citySessions = store.sessionsOf("p-city");
      expect(citySessions).toHaveLength(2); // 空首启 + 新建 2
      expect(citySessions.slice(0, 2).map((s) => s.title)).toEqual(["b", "a"]);
      expect(first.workspaceId).toBe("p-city");
      expect(store.sessionsOf(null).some((s) => s.title === "a" || s.title === "b")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("归属迁移与持久化", () => {
  it("旧版 v1（projectId）会话数据迁移为 workspaceId", () => {
    injectStorage();
    try {
      storageHolder.localStorage?.setItem(
        "greywork.sessions",
        JSON.stringify({
          version: 1,
          sessions: [{ id: "old-1", title: "旧会话", projectId: "p-city", createdAt: 1, updatedAt: 2, messages: [] }],
          activeSessionId: "old-1",
        }),
      );
      const store = useSessionStore();
      const migrated = store.getSession("old-1");
      expect(migrated?.title).toBe("旧会话");
      expect(migrated?.workspaceId).toBe("p-city");
      expect(store.activeSessionId).toBe("old-1");
    } finally {
      delete storageHolder.localStorage;
    }
  });

  it("reassignWorkspace 把工作区会话迁移到普通对话", () => {
    const store = useSessionStore();
    store.createSession("p-city");
    store.createSession("p-city", "second");
    const orphan = store.createSession(null);

    store.reassignWorkspace("p-city", null);
    expect(store.sessionsOf("p-city")).toHaveLength(0);
    expect(store.sessionsOf(null)).toHaveLength(3); // 孤儿 1 + 迁移 2
    expect(store.sessionsOf(null).some((s) => s.id === orphan.id)).toBe(true);
  });

  it("写操作落盘，重新加载后状态还原", () => {
    injectStorage();
    try {
      const store = useSessionStore();
      const session = store.createSession("p-general", "持久化会话");
      store.appendMessage(session.id, { id: "m-x", role: "user", content: "内容", ts: Date.now() });

      // 同一 localStorage 上重建（新 pinia），读取应还原
      setActivePinia(createPinia());
      const reloaded = useSessionStore();
      const restored = reloaded.getSession(session.id);
      expect(restored?.title).toBe("持久化会话");
      expect(restored?.workspaceId).toBe("p-general");
      expect(restored?.messages[0]?.content).toBe("内容");
      expect(reloaded.activeSessionId).toBe(session.id);
    } finally {
      delete storageHolder.localStorage;
    }
  });

  it("markDirty 契约：绕过 action 的深层就地修改，500ms 防抖后落盘", () => {
    injectStorage();
    vi.useFakeTimers();
    try {
      const store = useSessionStore();
      const session = store.createSession(null, "深层修改");
      store.appendMessage(session.id, { id: "deep-1", role: "assistant", content: "", ts: Date.now() });
      // 流式管线就是这样在 action 之外直接改 message.content / segments
      const message = store.getSession(session.id)!.messages[0]!;
      message.content += "流式增量";
      (message.segments ??= []).push({ kind: "text", id: "s-1", from: 0, to: null });

      // 未打脏前不落盘（这是与 deep watch 的行为差：必须显式 markDirty）
      setActivePinia(createPinia());
      expect(useSessionStore().getSession(session.id)?.messages[0]?.content).toBe("");

      // 打脏后推进 500ms → 落盘；重建读取应还原
      store.markDirty();
      vi.advanceTimersByTime(500);
      setActivePinia(createPinia());
      const reloaded = useSessionStore();
      expect(reloaded.getSession(session.id)?.messages[0]?.content).toBe("流式增量");
      expect(reloaded.getSession(session.id)?.messages[0]?.segments).toEqual([{ kind: "text", id: "s-1", from: 0, to: null }]);
    } finally {
      vi.useRealTimers();
      delete storageHolder.localStorage;
    }
  });
});

describe("acp 绑定（惰性恢复数据）", () => {
  it("setAcpBinding 写入并随 persist/重载往返", () => {
    injectStorage();
    try {
      const store = useSessionStore();
      const session = store.createSession(null, "绑定会话");
      const binding = { sessionId: "acp-sess-1", providerId: "claude-code", cwd: "/home/test/proj", savedAt: 1234 };
      store.setAcpBinding(session.id, binding);

      setActivePinia(createPinia());
      const reloaded = useSessionStore();
      expect(reloaded.getSession(session.id)?.acp).toEqual(binding);
    } finally {
      delete storageHolder.localStorage;
    }
  });

  it("setAcpBinding 传 null 清除绑定", () => {
    injectStorage();
    try {
      const store = useSessionStore();
      const session = store.createSession(null, "清除绑定");
      store.setAcpBinding(session.id, { sessionId: "s1", providerId: "p1", cwd: "/cwd", savedAt: 1 });
      expect(store.getSession(session.id)?.acp?.sessionId).toBe("s1");

      store.setAcpBinding(session.id, null);
      expect(store.getSession(session.id)?.acp).toBeUndefined();
      setActivePinia(createPinia());
      expect(useSessionStore().getSession(session.id)?.acp).toBeUndefined();
    } finally {
      delete storageHolder.localStorage;
    }
  });

  it("历史消息 adoption 不丢 acp 字段（消息段落归一只改 messages）", () => {
    injectStorage();
    try {
      const store = useSessionStore();
      const session = store.createSession("p-x", "adopt");
      store.appendMessage(session.id, {
        id: "m-old",
        role: "assistant",
        content: "旧文",
        ts: Date.now(),
        segments: [{ kind: "text", id: "t1", from: 0, to: null }],
      });
      store.setAcpBinding(session.id, { sessionId: "s-acp", providerId: "p1", cwd: "/c", savedAt: 5 });

      // 模拟落盘侧回灌整表（adoptSessions 路径）
      setActivePinia(createPinia());
      const reloaded = useSessionStore();
      expect(reloaded.getSession(session.id)?.acp?.sessionId).toBe("s-acp");
    } finally {
      delete storageHolder.localStorage;
    }
  });

  it("历史消息的旧形状附件（string[] / 畸形对象）在回灌时被丢弃，合法记录保留", () => {
    injectStorage();
    try {
      const store = useSessionStore();
      const session = store.createSession("p-x", "attachments");
      const legacy = {
        id: "m-legacy",
        role: "user" as const,
        content: "旧附件",
        ts: Date.now(),
        attachments: ["a.png"] as unknown as Attachment[],
      };
      const broken = {
        id: "m-broken",
        role: "user" as const,
        content: "畸形附件",
        ts: Date.now(),
        attachments: [{ id: "x" }] as unknown as Attachment[],
      };
      const valid: Attachment = { id: "att-1", kind: "image", name: "a.png", mime: "image/png", size: 4, path: "/tmp/a.png" };
      const kept = { id: "m-kept", role: "user" as const, content: "新附件", ts: Date.now(), attachments: [valid] };
      store.appendMessage(session.id, legacy);
      store.appendMessage(session.id, broken);
      store.appendMessage(session.id, kept);

      // 模拟落盘侧回灌整表（adoptSessions → adoptMessages 归一化）
      setActivePinia(createPinia());
      const reloaded = useSessionStore();
      const messages = reloaded.getSession(session.id)?.messages ?? [];
      expect(messages.find((item) => item.id === "m-legacy")?.attachments).toBeUndefined();
      expect(messages.find((item) => item.id === "m-broken")?.attachments).toBeUndefined();
      expect(messages.find((item) => item.id === "m-kept")?.attachments).toEqual([valid]);
    } finally {
      delete storageHolder.localStorage;
    }
  });
});
