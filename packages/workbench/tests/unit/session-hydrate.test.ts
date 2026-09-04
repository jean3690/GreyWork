/**
 * session store 桌面态（~/.greyWork 文件真源）接管语义测试。
 *
 * - 已接管（load 返回快照）→ hydrate 后文件内容覆盖首帧缓存，随后 debounce 同步回写；
 * - 未接管（load=null）→ 当前（种子/缓存）内容作为真源首落文件（store_sessions_sync）；
 * - load 失败 → 降级沿用缓存，不抛、不丢内存状态。
 * - 工作区目录随快照透传（测试环境无磁盘文件夹 → workspaces: []）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

import { useSessionStore } from "../../src/stores/session";

const storageHolder = globalThis as { localStorage?: Storage };

function installLocalStorage(): void {
  const store = new Map<string, string>();
  storageHolder.localStorage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(key, String(value)),
  };
}

const dbSnapshot = {
  sessions: [
    {
      id: "ses-db-1",
      title: "库中会话",
      workspaceId: null,
      createdAt: 111,
      updatedAt: 222,
      messages: [{ id: "m9", role: "user", content: "库消息", ts: 200 }],
    },
  ],
  activeSessionId: "ses-db-1",
};

describe("session store 桌面接管（~/.greyWork 文件真源）", () => {
  beforeEach(() => {
    installLocalStorage();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invokeMock.mockReset();
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete storageHolder.localStorage;
  });

  it("已接管：hydrate 后文件快照覆盖首帧（localStorage 仅缓存）", async () => {
    invokeMock.mockResolvedValue(dbSnapshot);
    const store = useSessionStore();
    await store.hydrated;

    expect(invokeMock).toHaveBeenCalledWith("store_sessions_load", { workspaces: [] });
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]).toMatchObject({
      id: "ses-db-1",
      title: "库中会话",
      messages: [{ id: "m9", role: "user", content: "库消息", ts: 200 }],
    });
    expect(store.activeSessionId).toBe("ses-db-1");
  });

  it("未接管：load=null → 本地内容作为真源首落文件", async () => {
    invokeMock.mockResolvedValue(null);
    const store = useSessionStore();
    await store.hydrated;

    expect(store.sessions.length).toBeGreaterThan(0);
    expect(invokeMock).toHaveBeenCalledWith(
      "store_sessions_sync",
      expect.objectContaining({ snapshot: expect.any(Object), workspaces: [] }),
    );
  });

  it("load 失败：降级沿用本地缓存，不抛错", async () => {
    invokeMock.mockRejectedValue(new Error("文件损坏"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = useSessionStore();
    await store.hydrated;

    expect(store.sessions.length).toBeGreaterThan(0);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("接管后变更经 persist 双写回文件（createSession 立即同步）", async () => {
    invokeMock.mockResolvedValue(dbSnapshot);
    const store = useSessionStore();
    await store.hydrated;

    const created = store.createSession(null, "新桌面会话");
    expect(invokeMock).toHaveBeenLastCalledWith(
      "store_sessions_sync",
      expect.objectContaining({
        snapshot: expect.objectContaining({
          activeSessionId: created.id,
        }),
        workspaces: [],
      }),
    );
  });

  // 段落表是后加的：老档只有平铺的 thinking / tools，接管时必须归一，
  // 否则历史会话的推理与工具记录在新渲染路径下直接不显示。
  it("历史消息归一为段落：thinking → 思考段，tools → 工具段，正文补一段", async () => {
    invokeMock.mockResolvedValue({
      sessions: [
        {
          id: "ses-old",
          title: "老会话",
          workspaceId: null,
          createdAt: 1,
          updatedAt: 2,
          messages: [
            {
              id: "m-old",
              role: "assistant",
              content: "结论如上",
              ts: 1000,
              thinking: "旧档里的推理",
              thinkingAt: 900,
              thinkingFor: 1500,
              tools: [{ toolCallId: "tc-1", kind: "read", status: "completed", startedAt: 950, finishedAt: 980 }],
            },
          ],
        },
      ],
      activeSessionId: "ses-old",
    });
    const store = useSessionStore();
    await store.hydrated;

    const segments = store.sessions[0]?.messages[0]?.segments ?? [];
    expect(segments.map((segment) => segment.kind)).toEqual(["thinking", "tools", "text"]);
    expect(segments[0]).toMatchObject({ kind: "thinking", text: "旧档里的推理", startedAt: 900, endedAt: 2400 });
    expect(segments[1]).toMatchObject({ kind: "tools", toolCallIds: ["tc-1"] });
    expect(segments[2]).toMatchObject({ kind: "text", from: 0, to: null });
  });
});
