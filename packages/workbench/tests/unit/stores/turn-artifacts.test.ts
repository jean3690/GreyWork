// 成功回合的磁盘产物自动开右栏预览：宿主把工作区内本回合修改过的文档类文件
// 随 prompt-done 的 files 带回，agent store 逐个 preview.open(disk)；
// 失败回合（带 error）不弹；重复产物只聚焦不重复开 tab。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { AcpEventEnvelope } from "@greywork/acp";

const h = vi.hoisted(() => ({
  startAgent: vi.fn(),
  openSession: vi.fn(),
  loadSession: vi.fn(),
  setSessionConfig: vi.fn(),
  setPermissionTier: vi.fn(),
  prompt: vi.fn(),
  probeMcp: vi.fn(),
  respondPermission: vi.fn(),
  stop: vi.fn(),
  isAvailable: vi.fn(() => true),
  homeDir: vi.fn<() => Promise<string | null>>(() => Promise.resolve("/home/test")),
  listener: null as ((event: AcpEventEnvelope) => void) | null,
}));

vi.mock("@greywork/acp", () => ({
  createAcpClient: () =>
    ({
      isAvailable: () => h.isAvailable(),
      startAgent: (cmd: string, tier: string) => h.startAgent(cmd, tier),
      openSession: (handle: number, cwd: string, mcpServers?: unknown) => h.openSession(handle, cwd, mcpServers),
      loadSession: (handle: number, cwd: string, sessionId: string, mcpServers?: unknown) =>
        h.loadSession(handle, cwd, sessionId, mcpServers),
      probeMcp: (config: unknown) => h.probeMcp(config),
      setSessionConfig: (handle: number, configId: string, value: string | boolean) => h.setSessionConfig(handle, configId, value),
      setPermissionTier: (handle: number, tier: string) => h.setPermissionTier(handle, tier),
      prompt: (handle: number, text: string) => h.prompt(handle, text),
      stop: (handle: number, turnId?: number) => h.stop(handle, turnId),
      respondPermission: (requestId: number, optionId: string | null) => h.respondPermission(requestId, optionId),
      onEvent: (listener: (event: AcpEventEnvelope) => void) => {
        h.listener = listener;
        return Promise.resolve(() => undefined);
      },
    }) as never,
  desktopHomeDir: () => h.homeDir(),
}));

import { useAgentStore } from "@/stores/agent";
import { usePreviewStore } from "@/stores/preview";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";

const storageHolder = globalThis as { localStorage?: Storage };

/** node 环境注入内存 localStorage（会话/偏好持久化走 createJsonStorage）。 */
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

function emit(event: AcpEventEnvelope): void {
  expect(h.listener).not.toBeNull();
  h.listener?.(event);
}

beforeEach(() => {
  setActivePinia(createPinia());
  // ACP 建会话要解析工作区：node 环境非 Tauri 运行时，设置项为空则 resolveWorkspaceDir 抛错。
  useSettingsStore().workspaceDir = "/home/test";
  vi.clearAllMocks();
  injectStorage();
  h.isAvailable.mockImplementation(() => true);
  h.homeDir.mockImplementation(() => Promise.resolve("/home/test"));
  h.listener = null;
  h.startAgent.mockResolvedValue(7);
  h.openSession.mockResolvedValue({ sessionId: "new-session", configOptions: [] });
  h.loadSession.mockResolvedValue({ sessionId: "loaded", configOptions: [], restored: true });
  h.prompt.mockResolvedValue({ turnId: 1 });
});

/** 新会话派发一轮（无绑定 → openSession），返回后即可 emit 回合事件。 */
async function runTurn(text = "做一份表格"): Promise<void> {
  useSessionStore().createSession(null, "产物回合");
  await useAgentStore().dispatchToAcp(text);
}

describe("真实 ACP 回合产物自动开预览", () => {
  it("prompt-done 带 files → 右栏展开并逐个开 disk tab", async () => {
    await runTurn();
    expect(usePreviewStore().tabs).toHaveLength(0);

    emit({
      kind: "prompt-done",
      payload: {
        turnId: 1,
        response: {},
        files: ["/home/test/out/data.xlsx", "/home/test/out/报告.md"],
      },
    });

    const preview = usePreviewStore();
    expect(preview.collapsed).toBe(false);
    expect(preview.tabs.map((tab) => ({ path: tab.path, name: tab.name, source: tab.source }))).toEqual([
      { path: "/home/test/out/data.xlsx", name: "data.xlsx", source: "disk" },
      { path: "/home/test/out/报告.md", name: "报告.md", source: "disk" },
    ]);
    expect(preview.activeTab?.path).toBe("/home/test/out/报告.md");
  });

  it("同一文件再次出现 → 只聚焦不重复开 tab", async () => {
    await runTurn();
    emit({
      kind: "prompt-done",
      payload: { turnId: 1, response: {}, files: ["/home/test/out/brief.pptx"] },
    });
    // 第二轮更新同一产物：仍是同一个 tab
    emit({
      kind: "prompt-done",
      payload: { turnId: 2, response: {}, files: ["/home/test/out/brief.pptx"] },
    });

    const preview = usePreviewStore();
    expect(preview.tabs).toHaveLength(1);
    expect(preview.tabs[0]?.path).toBe("/home/test/out/brief.pptx");
  });

  it("失败回合（带 error）→ 不弹预览", async () => {
    await runTurn();
    emit({
      kind: "prompt-done",
      payload: { turnId: 1, error: "session/load failed", files: ["/home/test/out/broken.xlsx"] },
    });

    const preview = usePreviewStore();
    expect(preview.tabs).toHaveLength(0);
    expect(preview.collapsed).toBe(true);
  });

  it("files 为空或畸形 → 不弹、不报错", async () => {
    await runTurn();
    emit({ kind: "prompt-done", payload: { turnId: 1, response: {}, files: [] } });
    emit({ kind: "prompt-done", payload: { turnId: 2, response: {} } });
    emit({ kind: "prompt-done", payload: { turnId: 3, response: {}, files: [42, "", "  "] } });

    expect(usePreviewStore().tabs).toHaveLength(0);
  });
});
