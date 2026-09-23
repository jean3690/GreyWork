// 联系人档案切片的可观测契约：查找 / 排序 / 已读游标 / 会话桥接（复用或新建并还原激活位）/
// 持久化（localStorage）与消息落会话。切片经 createPeersSlice({ state }) 直接注入。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import type { Attachment, ThreadMessage } from "@/types";
import type { RemotePeer } from "@/stores/remote-assistant/shared";
import { createPeersSlice, type PeersApi } from "@/stores/remote-assistant/peers";
import type { RemoteAssistantState } from "@/stores/remote-assistant/state";

const t = i18n.global.t;

const PEER_ARCHIVE_KEY = "greywork.remote-assistant.peers";

interface FakeSession {
  id: string;
  title: string;
  workspaceId: string | null;
  messages: ThreadMessage[];
}

interface PeerHarness {
  api: PeersApi;
  peersRef: { value: RemotePeer[] };
  session: {
    getSession(id: string): FakeSession | undefined;
    activeSessionId: string | null;
    createSession(workspaceId: string | null, title: string): FakeSession;
    setActive(id: string | null): void;
    appendMessage(id: string, message: ThreadMessage): void;
    markDirty(): void;
    dirtyCount(): number;
    sessionCount(): number;
  };
  workspaceId: string | null;
  storage: Storage & { dump(): string | null };
  addSession(id: string): FakeSession;
}

function installStorage(): PeerHarness["storage"] {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => void store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
    dump: () => store.get(PEER_ARCHIVE_KEY) ?? null,
  } as unknown as PeerHarness["storage"];
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  return storage;
}

function peer(overrides: Partial<RemotePeer> = {}): RemotePeer {
  return {
    channel: "dingtalk",
    id: "u1",
    nick: "阿甲",
    sessionId: "s-1",
    contextToken: null,
    lastAt: 10,
    lastText: "hi",
    readAt: 0,
    ...overrides,
  };
}

function build(): PeerHarness {
  const storage = installStorage();
  const peers: RemotePeer[] = [peer()];
  const peersRef = { value: peers };
  const sessions = new Map<string, FakeSession>();
  let seq = 0;
  let dirty = 0;
  const workspaceId: string | null = "ws-1";
  const remoteWorkspace = {
    id: "w-remote",
    name: "远程助手",
    description: "",
    files: [],
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: 1,
    icon: "robot",
  };
  const workspace = {
    activeWorkspaceId: workspaceId,
    workspaceById: (id: string | null) => (id === remoteWorkspace.id ? remoteWorkspace : undefined),
    ensureWorkspace: () => remoteWorkspace,
  };
  const session = {
    activeSessionId: null as string | null,
    getSession(id: string) {
      return sessions.get(id);
    },
    createSession(workspaceIdArg: string | null, title: string) {
      const id = `s-${++seq}`;
      const record: FakeSession = { id, title, workspaceId: workspaceIdArg, messages: [] };
      sessions.set(id, record);
      session.activeSessionId = id;
      return record;
    },
    setActive(id: string | null) {
      session.activeSessionId = id;
    },
    appendMessage(id: string, message: ThreadMessage) {
      sessions.get(id)?.messages.push(message);
    },
    markDirty() {
      dirty += 1;
    },
    dirtyCount: () => dirty,
    sessionCount: () => sessions.size,
  };
  const api = createPeersSlice({
    state: { peers: peersRef, session, workspace } as unknown as RemoteAssistantState,
  });
  return {
    api,
    peersRef,
    session,
    workspaceId,
    storage,
    addSession(id: string) {
      const record: FakeSession = { id, title: id, workspaceId: null, messages: [] };
      sessions.set(id, record);
      return record;
    },
  };
}

/** 从归档快照里取某个 peer（验证 persistPeers 落盘的内容）。 */
function archivedPeer(h: PeerHarness, key: string): RemotePeer | undefined {
  const raw = h.storage.dump();
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as { peers: RemotePeer[] };
  return parsed.peers.find((p) => `${p.channel}:${p.id}` === key);
}

beforeEach(() => {
  vi.restoreAllMocks();
  installStorage();
});

describe("查找与排序", () => {
  it("peerByKey：按 channel:id 复合主键命中，未知键返回 undefined", () => {
    const h = build();
    expect(h.api.peerByKey("dingtalk:u1")?.nick).toBe("阿甲");
    expect(h.api.peerByKey("dingtalk:nope")).toBeUndefined();
    expect(h.api.peerByKey("wechat:u1")).toBeUndefined();
  });

  it("peerList：最近有往来在前", () => {
    const h = build();
    h.peersRef.value = [
      peer({ channel: "qq", id: "q1", nick: "Q", lastAt: 1, sessionId: "s-q" }),
      peer({ channel: "wechat", id: "w1", nick: "微", lastAt: 30, sessionId: "s-w" }),
      peer({ id: "u2", nick: "乙", lastAt: 20, sessionId: "s-2" }),
    ];
    expect(h.api.peerList.value.map((p) => p.id)).toEqual(["w1", "u2", "q1"]);
  });
});

describe("已读游标", () => {
  it("markPeerRead：readAt < lastAt 时推进到 lastAt 并落盘", () => {
    const h = build();
    h.api.markPeerRead("dingtalk:u1");
    expect(h.peersRef.value[0].readAt).toBe(10);
    expect(archivedPeer(h, "dingtalk:u1")?.readAt).toBe(10);
  });

  it("markPeerRead：已读过的不重复触发持久化", () => {
    const h = build();
    h.peersRef.value[0].readAt = 10;
    h.api.markPeerRead("dingtalk:u1");
    expect(archivedPeer(h, "dingtalk:u1")).toBeUndefined();
  });

  it("markPeerRead：未知联系人静默忽略", () => {
    const h = build();
    h.api.markPeerRead("dingtalk:ghost");
    expect(h.storage.dump()).toBeNull();
  });
});

describe("联系人 → 会话桥接", () => {
  it("已有会话且存续：沿用，不再新建", () => {
    const h = build();
    h.addSession("s-1");
    const id = h.api.peerSessionId(h.peersRef.value[0]);
    expect(id).toBe("s-1");
    expect(h.session.sessionCount()).toBe(1);
  });

  it("无会话：新建会话并用联系人名做标题", () => {
    const h = build();
    const fresh = peer({ sessionId: "" });
    const id = h.api.peerSessionId(fresh);
    const record = h.session.getSession(id);
    expect(record?.title).toBe(`${t("remoteAssist.channels.dingtalk")} · 阿甲`);
  });

  it("无会话：新联系人追加进档案并落盘", () => {
    const h = build();
    const fresh = peer({ sessionId: "" });
    const id = h.api.peerSessionId(fresh);
    expect(archivedPeer(h, "dingtalk:u1")?.sessionId).toBe(id);
  });

  it("无会话：已建档的联系人被回写 sessionId（档案原样保留位置）", () => {
    const h = build();
    h.peersRef.value[0].sessionId = "gone"; // 会话已被删除
    const id = h.api.peerSessionId(h.peersRef.value[0]);
    expect(id).not.toBe("gone");
    expect(h.peersRef.value[0].sessionId).toBe(id);
  });

  it("resetChannelSessions：只作废指定通道的会话与 contextToken", () => {
    const h = build();
    h.peersRef.value = [
      peer({ channel: "wechat", id: "w1", sessionId: "old-wechat", contextToken: "token" }),
      peer({ channel: "dingtalk", id: "d1", sessionId: "keep", contextToken: null }),
    ];
    h.api.resetChannelSessions("wechat");
    expect(h.peersRef.value[0]).toMatchObject({ sessionId: "", contextToken: null });
    expect(h.peersRef.value[1]).toMatchObject({ sessionId: "keep", contextToken: null });
    expect(archivedPeer(h, "wechat:w1")?.sessionId).toBe("");
  });

  it("新建会话不把用户正在看的会话切走（活动位还原）", () => {
    const h = build();
    h.session.setActive("watching");
    h.api.peerSessionId(peer({ sessionId: "" }));
    expect(h.session.activeSessionId).toBe("watching");
  });
});

describe("消息落会话", () => {
  it("appendRemoteMessage：生成 wm 前缀 id，落进会话并返回", () => {
    const h = build();
    h.addSession("s-1");
    const message = h.api.appendRemoteMessage("s-1", "user", "你好");
    expect(message.id.startsWith("wm")).toBe(true);
    expect(message.role).toBe("user");
    expect(message.content).toBe("你好");
    expect(typeof message.ts).toBe("number");
    expect(h.session.getSession("s-1")?.messages).toHaveLength(1);
  });

  it("appendRemoteMessage：带附件时挂到消息上；空附件不写空数组字段", () => {
    const h = build();
    h.addSession("s-1");
    const image: Attachment = { id: "att-1", kind: "image", name: "pic.png", mime: "image/png", size: 3, path: "/tmp/pic.png" };

    const withMedia = h.api.appendRemoteMessage("s-1", "user", "", [image]);
    expect(withMedia.attachments).toEqual([image]);

    const plain = h.api.appendRemoteMessage("s-1", "assistant", "好的");
    expect(plain.attachments).toBeUndefined();
  });

  it("updateRemoteMessage：就地改写正文并标脏；未知消息不动", () => {
    const h = build();
    h.addSession("s-1");
    const message = h.api.appendRemoteMessage("s-1", "assistant", "旧草稿");
    const before = h.session.dirtyCount();
    h.api.updateRemoteMessage("s-1", message.id, "收尾版本");
    expect(h.session.getSession("s-1")?.messages[0].content).toBe("收尾版本");
    expect(h.session.dirtyCount()).toBe(before + 1);

    h.api.updateRemoteMessage("s-1", "no-such-message", "忽略我");
    expect(h.session.dirtyCount()).toBe(before + 1);
  });

  it("readMessageContent：取正文，未知消息返回空串", () => {
    const h = build();
    h.addSession("s-1");
    const message = h.api.appendRemoteMessage("s-1", "user", "可读内容");
    expect(h.api.readMessageContent("s-1", message.id)).toBe("可读内容");
    expect(h.api.readMessageContent("s-1", "ghost")).toBe("");
    expect(h.api.readMessageContent("no-session", "ghost")).toBe("");
  });
});
