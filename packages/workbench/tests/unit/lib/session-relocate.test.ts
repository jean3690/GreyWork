/**
 * 会话搬迁：只在「落盘按工作区分目录」的桌面态发命令，且把该工作区名下的会话 id
 * 全量交给宿主；浏览器态（含 WebDAV 平铺）直接零值返回，不误发命令。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const h = vi.hoisted(() => ({ hasWorkspaceDirs: vi.fn(() => true) }));

vi.mock("../../../src/lib/session-backend", () => ({
  sessionBackend: {
    active: () => false,
    hasWorkspaceDirs: () => h.hasWorkspaceDirs(),
    load: () => Promise.resolve(null),
    save: () => Promise.resolve({ written: 0, skipped: 0, deleted: 0, conflicts: [] }),
  },
  toWorkspaceDirRefs: () => [],
}));

import { relocateWorkspaceSessions } from "../../../src/lib/session-relocate";
import { useSessionStore } from "../../../src/stores/session";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  h.hasWorkspaceDirs.mockReturnValue(true);
});

describe("relocateWorkspaceSessions", () => {
  it("把该工作区的会话 id 交给宿主，from/to 用 null 表达「默认根」", async () => {
    const sessionStore = useSessionStore();
    sessionStore.createSession("ws-1", "会话一");
    sessionStore.createSession("ws-1", "会话二");
    sessionStore.createSession("ws-2", "别的工作区");
    const report = { moved: 2, missing: [], conflicts: [] };
    invokeMock.mockResolvedValue(report);

    expect(await relocateWorkspaceSessions("ws-1", undefined, "/home/u/proj")).toEqual(report);
    const [command, payload] = invokeMock.mock.calls[0]!;
    expect(command).toBe("store_sessions_relocate");
    const request = (payload as { request: { sessionIds: string[]; fromFolder: string | null; toFolder: string | null } }).request;
    expect(request.fromFolder).toBeNull();
    expect(request.toFolder).toBe("/home/u/proj");
    expect(request.sessionIds).toHaveLength(2);
  });

  it("没有归属会话时不发命令", async () => {
    useSessionStore();
    expect(await relocateWorkspaceSessions("ws-empty", "/a", "/b")).toEqual({ moved: 0, missing: [], conflicts: [] });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("落盘侧不分目录（浏览器/远端）时直接零值返回", async () => {
    h.hasWorkspaceDirs.mockReturnValue(false);
    const sessionStore = useSessionStore();
    sessionStore.createSession("ws-1", "会话一");
    expect(await relocateWorkspaceSessions("ws-1", "/a", "/b")).toEqual({ moved: 0, missing: [], conflicts: [] });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
