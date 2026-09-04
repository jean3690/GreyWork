/**
 * ACP 后端目录管理（Agent 管理面）：桌面接管 + 启停双写 + 禁用当前切 Local。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { AcpEventEnvelope } from "@greywork/acp";

const h = vi.hoisted(() => ({
  startAgent: vi.fn(),
  openSession: vi.fn(),
  setSessionConfig: vi.fn(),
  prompt: vi.fn(),
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
      openSession: (handle: number, cwd: string) => h.openSession(handle, cwd),
      setSessionConfig: (handle: number, configId: string, value: string | boolean) => h.setSessionConfig(handle, configId, value),
      setPermissionTier: () => Promise.resolve(),
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

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked((await import("@tauri-apps/api/core")).invoke);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useAgentStore } from "@/stores/agent";

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

function installInvoke(agentsLoad: unknown): void {
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "db_agents_load":
        return Promise.resolve(agentsLoad);
      case "db_settings_load":
      case "db_sessions_load":
      case "db_automations_load":
      case "db_team_runs_load":
        return Promise.resolve(null);
      default:
        return Promise.resolve(undefined);
    }
  });
}

const dbProviders = [
  { id: "opencode", name: "OpenCode", kind: "acp", command: "opencode acp", enabled: true },
  { id: "codex", name: "Codex", kind: "acp", command: "codex acp", enabled: true },
];

describe("agent 后端目录（桌面态：SQLite 真源）", () => {
  beforeEach(() => {
    installLocalStorage();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invokeMock.mockReset();
    setActivePinia(createPinia());
    h.isAvailable.mockImplementation(() => true);
    h.listener = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete storageHolder.localStorage;
    vi.clearAllMocks();
  });

  it("库已接管：hydrate 后目录覆盖内置缺省", async () => {
    installInvoke(dbProviders);
    const agentStore = useAgentStore();
    await agentStore.providersHydrated;

    expect(agentStore.agentProviders).toHaveLength(2);
    expect(agentStore.agentProviders.map((p) => p.id)).toEqual(["opencode", "codex"]);
    expect(agentStore.agentProviders.every((p) => p.enabled)).toBe(true);
  });

  it("库未接管：内置缺省首落库", async () => {
    installInvoke(null);
    const agentStore = useAgentStore();
    await agentStore.providersHydrated;

    expect(agentStore.agentProviders.length).toBeGreaterThanOrEqual(4); // 内置缺省
    expect(invokeMock).toHaveBeenCalledWith("db_agents_sync", expect.objectContaining({ providers: expect.any(Array) }));
  });

  it("启停切换：ref 更新 + 双写（SQLite sync + localStorage 缓存）", async () => {
    installInvoke(dbProviders);
    const agentStore = useAgentStore();
    await agentStore.providersHydrated;

    await agentStore.setAgentProviderEnabled("codex", false);
    expect(agentStore.agentProviders.find((p) => p.id === "codex")?.enabled).toBe(false);
    const syncCall = invokeMock.mock.calls.find(([cmd]) => cmd === "db_agents_sync");
    const providers = (syncCall?.[1] as { providers: Array<{ id: string; enabled: boolean }> }).providers;
    expect(providers.find((p) => p.id === "codex")?.enabled).toBe(false);
    const cached = JSON.parse(localStorage.getItem("greywork.agent-providers") ?? "{}");
    expect(cached.providers.find((p: { id: string }) => p.id === "codex")?.enabled).toBe(false);
  });

  it("禁用当前选中后端（routeToAcp 中）→ 自动切回 Local", async () => {
    installInvoke(dbProviders);
    const agentStore = useAgentStore();
    await agentStore.providersHydrated;

    await agentStore.activateAcpProvider("opencode");
    expect(agentStore.routeToAcp).toBe(true);

    await agentStore.setAgentProviderEnabled("opencode", false);
    expect(agentStore.routeToAcp).toBe(false);
    expect(JSON.parse(localStorage.getItem("greywork.acp-provider") ?? "{}")).toEqual({ providerId: null });
  });
});
