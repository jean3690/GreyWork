/**
 * session-backend 三态 transport 测试。
 *
 * 桌面态（stub window + mock invoke）→ 命令名（store_sessions_*）与快照/工作区目录形状对齐 Rust DTO，
 * 并把删除清单显式送达、把同步报告原样回传；
 * 浏览器态未配远端 → load=null / save=no-op / active=false；
 * 浏览器态配了 WebDAV → 真落盘（sessions/<id>.json + active.json + .ready）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

import { sessionBackend, toWorkspaceDirRefs } from "../../src/lib/session-backend";

const snapshotDto = {
  sessions: [
    {
      id: "ses-a",
      title: "会话 A",
      workspaceId: "ws-1",
      createdAt: 1000,
      updatedAt: 2000,
      messages: [{ id: "m1", role: "user", content: "你好", ts: 1500 }],
    },
  ],
  activeSessionId: "ses-a",
};

const dirs = [{ id: "ws-1", folder: "/home/user/proj" }];
const emptyReport = { written: 0, skipped: 0, deleted: 0, conflicts: [] };

/** 极简 localStorage 替身（remote-store-config 经 @greywork/core 的 createJsonStorage 读它）。 */
function fakeLocalStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("sessionBackend 浏览器态（无 Tauri、未配远端）", () => {
  it("load 返回 null，不触 invoke", async () => {
    expect(await sessionBackend.load([])).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("save 为 no-op 并回空报告，不触 invoke", async () => {
    expect(await sessionBackend.save({ sessions: [], activeSessionId: null }, [])).toEqual(emptyReport);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("active/hasWorkspaceDirs 均为假", () => {
    expect(sessionBackend.active()).toBe(false);
    expect(sessionBackend.hasWorkspaceDirs()).toBe(false);
  });
});

describe("sessionBackend 桌面态（Tauri invoke）", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    invokeMock.mockReset();
  });

  it("load 带工作区目录调用 store_sessions_load，接管时回传快照", async () => {
    invokeMock.mockResolvedValue(snapshotDto);
    const snapshot = await sessionBackend.load(dirs);
    expect(invokeMock).toHaveBeenCalledWith("store_sessions_load", { workspaces: dirs });
    expect(snapshot).toEqual(snapshotDto);
  });

  it("load 遇未接管（null）回传 null", async () => {
    invokeMock.mockResolvedValue(null);
    expect(await sessionBackend.load(dirs)).toBeNull();
  });

  it("save 显式送达删除清单并原样回传同步报告", async () => {
    const report = { written: 1, skipped: 2, deleted: 1, conflicts: [{ id: "ses-x", diskUpdatedAt: 9000 }] };
    invokeMock.mockResolvedValue(report);
    const snapshot = { sessions: snapshotDto.sessions, activeSessionId: null };
    expect(await sessionBackend.save(snapshot, dirs, ["ses-x"])).toEqual(report);
    expect(invokeMock).toHaveBeenCalledWith("store_sessions_sync", {
      snapshot,
      workspaces: dirs,
      deletedSessionIds: ["ses-x"],
    });
  });

  it("旧宿主返回 null 时归一化为空报告（新前端 + 旧二进制不炸）", async () => {
    invokeMock.mockResolvedValue(null);
    expect(await sessionBackend.save({ sessions: [], activeSessionId: null }, [])).toEqual(emptyReport);
  });

  it("桌面态才有按工作区分目录", () => {
    expect(sessionBackend.active()).toBe(true);
    expect(sessionBackend.hasWorkspaceDirs()).toBe(true);
  });

  it("toWorkspaceDirRefs 只收绝对路径文件夹", () => {
    expect(toWorkspaceDirRefs([{ id: "a", folder: "/home/u/p" }, { id: "b", folder: "demo" }, { id: "c" }])).toEqual([
      { id: "a", folder: "/home/u/p" },
    ]);
  });
});

describe("sessionBackend 浏览器态 + WebDAV 远端", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage({
        "greywork.remote-store": JSON.stringify({ kind: "webdav", url: "https://dav.test/gw", username: "u", password: "p" }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("配好远端即视为有真源，且不走 invoke", async () => {
    expect(sessionBackend.active()).toBe(true);
    // 远端不按工作区分目录：会话平铺，归属靠 workspaceId 字段
    expect(sessionBackend.hasWorkspaceDirs()).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("远端无 .ready 标记 → load 回 null（保留「本地为真源」语义）", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve("") });
    expect(await sessionBackend.load([])).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("https://dav.test/gw/.ready", expect.objectContaining({ method: "GET" }));
  });

  it("save 写 sessions/<id>.json、active.json 与 .ready", async () => {
    const session = { id: "ses-remote", title: "远端", workspaceId: null, createdAt: 1, updatedAt: 2, messages: [] };
    fetchMock.mockImplementation((_url: string, init: { method: string }) => {
      if (init.method === "GET") return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") });
      return Promise.resolve({ ok: true, status: 201, text: () => Promise.resolve("") });
    });
    const report = await sessionBackend.save({ sessions: [session], activeSessionId: "ses-remote" }, []);
    expect(report.written).toBe(1);
    const puts = fetchMock.mock.calls.filter(([, init]) => init.method === "PUT").map(([url]) => url);
    expect(puts).toEqual(["https://dav.test/gw/sessions/ses-remote.json", "https://dav.test/gw/active.json", "https://dav.test/gw/.ready"]);
  });

  it("远端版本更新时报冲突且不覆盖", async () => {
    const local = { id: "ses-conflict", title: "本地旧", workspaceId: null, createdAt: 1, updatedAt: 100, messages: [] };
    const remote = JSON.stringify({ ...local, title: "远端新", updatedAt: 900 });
    fetchMock.mockImplementation((url: string, init: { method: string }) => {
      if (init.method === "GET" && String(url).endsWith("ses-conflict.json")) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(remote) });
      }
      if (init.method === "GET") return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") });
      return Promise.resolve({ ok: true, status: 201, text: () => Promise.resolve("") });
    });
    const report = await sessionBackend.save({ sessions: [local], activeSessionId: null }, []);
    expect(report.written).toBe(0);
    expect(report.conflicts).toEqual([{ id: "ses-conflict", diskUpdatedAt: 900 }]);
    const puts = fetchMock.mock.calls.filter(([, init]) => init.method === "PUT").map(([url]) => url);
    expect(puts).not.toContain("https://dav.test/gw/sessions/ses-conflict.json");
  });
});
