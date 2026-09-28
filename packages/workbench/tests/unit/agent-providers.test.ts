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

/** 桌面态的目录同步改走能力表（多一个微任务跳）：断言 sync 调用前先等它落地。 */
async function settleSync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const dbProviders = [
  { id: "opencode", name: "OpenCode", kind: "acp", command: "opencode acp", enabled: true },
  { id: "codex", name: "Codex", kind: "acp", command: "npx -y @agentclientprotocol/codex-acp", enabled: true },
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

  it("库已接管（旧快照仅 2 项）：merge 补齐全部预设，且保留库里的 enabled 偏好", async () => {
    installInvoke(dbProviders);
    const agentStore = useAgentStore();
    await agentStore.providersHydrated;
    await settleSync();

    // 旧库只有 opencode/codex，但合并后必须把新增预设（gemini/qwen/kimi…）带出来
    const ids = agentStore.agentProviders.map((p) => p.id);
    expect(ids).toContain("opencode");
    expect(ids).toContain("codex");
    expect(ids).toContain("gemini");
    expect(ids).toContain("qwen-code");
    expect(ids).toContain("kimi");
    expect(ids).toContain("amp");
    expect(ids.length).toBeGreaterThanOrEqual(12);
    // 库里的 enabled 偏好被保留；库没有的预设带默认 enabled（false）
    expect(agentStore.agentProviders.find((p) => p.id === "opencode")?.enabled).toBe(true);
    expect(agentStore.agentProviders.find((p) => p.id === "codex")?.enabled).toBe(true);
    expect(agentStore.agentProviders.find((p) => p.id === "gemini")?.enabled).toBe(false);
    // detect 元数据不落库，合并后按 id 从注册表补回
    expect(agentStore.agentProviders.find((p) => p.id === "opencode")?.detect).toEqual(["opencode"]);
    // 合并结果回写库（自修复旧快照）
    const syncCall = invokeMock.mock.calls.find(([cmd]) => cmd === "db_agents_sync");
    const synced = (syncCall?.[1] as { providers: Array<{ id: string }> }).providers;
    expect(synced.length).toBe(agentStore.agentProviders.length);
  });

  it("库未接管：内置缺省首落库", async () => {
    installInvoke(null);
    const agentStore = useAgentStore();
    await agentStore.providersHydrated;
    await settleSync();

    expect(agentStore.agentProviders.length).toBeGreaterThanOrEqual(3); // 内置缺省（mock-agent 已下线）
    expect(agentStore.agentProviders.some((p) => p.id === "mock-agent")).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("db_agents_sync", expect.objectContaining({ providers: expect.any(Array) }));
  });

  it("启停切换：ref 更新 + 双写（SQLite sync + localStorage 缓存）", async () => {
    installInvoke(dbProviders);
    const agentStore = useAgentStore();
    await agentStore.providersHydrated;
    await settleSync();

    await agentStore.setAgentProviderEnabled("codex", false);
    expect(agentStore.agentProviders.find((p) => p.id === "codex")?.enabled).toBe(false);
    // 取最后一次 sync（hydrate 自修复 + 本次切换各有一次；断言切换后的固化结果）
    const syncCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "db_agents_sync");
    const lastSync = syncCalls[syncCalls.length - 1]!;
    const providers = (lastSync[1] as { providers: Array<{ id: string; enabled: boolean }> }).providers;
    expect(providers.find((p) => p.id === "codex")?.enabled).toBe(false);
    const cached = JSON.parse(localStorage.getItem("greywork.agent-providers") ?? "{}");
    expect(cached.providers.find((p: { id: string }) => p.id === "codex")?.enabled).toBe(false);
  });

  it("CLI 安装探测：桌面态 PATH 命中→已安装，未命中→未安装", async () => {
    installInvoke(dbProviders);
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "db_agents_load":
          return Promise.resolve(dbProviders);
        case "acp_detect_programs":
          return Promise.resolve([
            { program: "opencode", installed: true, path: "/usr/bin/opencode" },
            { program: "codex", installed: false, path: null },
          ]);
        default:
          return Promise.resolve(undefined);
      }
    });
    const agentStore = useAgentStore();
    await agentStore.providersHydrated;
    await settleSync();

    // 探测前：状态未知
    expect(agentStore.providerInstalled(agentStore.agentProviders[0]!)).toBeNull();

    await agentStore.refreshAgentDetection();
    const opencode = agentStore.agentProviders.find((p) => p.id === "opencode")!;
    const codex = agentStore.agentProviders.find((p) => p.id === "codex")!;
    // detect 元数据不落库，从库读回后按 id 补回
    expect(opencode.detect).toEqual(["opencode"]);
    expect(agentStore.providerInstalled(opencode)).toBe(true);
    expect(agentStore.providerInstallLabel(opencode)).toBe("已安装");
    // codex 预设走官方 ACP 适配器（npx 分发）：本机没装原生 codex 时显示「首次启动下载」
    expect(agentStore.providerInstallLabel(codex)).toBe("首次启动下载");
  });

  it("npx 型后端未预装 → 提示首次启动下载（不是未安装）", async () => {
    installInvoke(null);
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "acp_detect_programs") {
        return Promise.resolve([{ program: "qwen", installed: false, path: null }]);
      }
      if (cmd === "db_agents_load") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
    const agentStore = useAgentStore();
    await agentStore.providersHydrated;
    await settleSync();
    await agentStore.refreshAgentDetection();

    const qwen = agentStore.agentProviders.find((p) => p.id === "qwen-code")!;
    expect(agentStore.providerInstallLabel(qwen)).toBe("首次启动下载");
  });

  it("禁用当前选中后端（routeToAcp 中）→ 自动切回 Local", async () => {
    installInvoke(dbProviders);
    const agentStore = useAgentStore();
    await agentStore.providersHydrated;
    await settleSync();

    await agentStore.activateAcpProvider("opencode");
    expect(agentStore.routeToAcp).toBe(true);

    await agentStore.setAgentProviderEnabled("opencode", false);
    expect(agentStore.routeToAcp).toBe(false);
    expect(JSON.parse(localStorage.getItem("greywork.acp-provider") ?? "{}")).toEqual({ providerId: null });
  });
});

/**
 * 服务端态：agent 目录只读（db_agents_sync 被服务端禁用）。
 *
 * 门装上之前，每次启动都会尝试 HTTP 同步 → 失败 → console.error + 通知，纯属噪音；
 * 现在写路径先问命令能力表（unknown 按不可写），available === true 时自动放行。
 */
describe("agent 后端目录（服务端态：只读门）", () => {
  beforeEach(() => {
    installLocalStorage();
    // 服务端态：显式覆盖键优先于一切探测（host-ipc 的运行时判定）。
    vi.stubGlobal("window", { __GREYWORK_RUNTIME__: "server" });
    setActivePinia(createPinia());
    h.isAvailable.mockImplementation(() => true);
    h.listener = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete storageHolder.localStorage;
    vi.clearAllMocks();
  });

  /** 假服务端：/api/commands 回能力表，/api/command 一律成功返回 null。 */
  function installServerFetch(catalogAvailable: boolean) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.endsWith("/api/commands")) {
        return new Response(
          JSON.stringify([{ name: "db_agents_sync", auth: "required", desktopOnly: false, binary: false, available: catalogAvailable }]),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/command")) return new Response(JSON.stringify(null), { status: 200 });
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function syncCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[] {
    return fetchMock.mock.calls.filter(([url, init]) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      return String(url).endsWith("/api/command") && body?.command === "db_agents_sync";
    });
  }

  it("db_agents_sync 被禁：启动不再尝试写 agent 目录，localStorage 覆盖层照常写", async () => {
    const fetchMock = installServerFetch(false);
    const agentStore = useAgentStore();
    await agentStore.providersHydrated;
    await settleSync();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(syncCalls(fetchMock)).toHaveLength(0);
    const cached = JSON.parse(localStorage.getItem("greywork.agent-providers") ?? "{}");
    expect(cached.providers.length).toBe(agentStore.agentProviders.length);
  });

  it("能力表回 available=true：写路径自动放行（服务端放开即恢复同步）", async () => {
    const fetchMock = installServerFetch(true);
    const agentStore = useAgentStore();
    await agentStore.providersHydrated;
    await settleSync();

    await vi.waitFor(() => expect(syncCalls(fetchMock).length).toBeGreaterThan(0));
    const lastSync = syncCalls(fetchMock).at(-1) as [string, { body: string }];
    const payload = JSON.parse(lastSync[1].body) as { args: { providers: unknown[] } };
    expect(payload.args.providers.length).toBe(agentStore.agentProviders.length);
  });

  it("能力表拉不到（unknown）：同样跳过同步（fail-closed），只留 localStorage", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.endsWith("/api/command")) return new Response(JSON.stringify(null), { status: 200 });
      return new Response(JSON.stringify({ error: "未认证" }), { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const agentStore = useAgentStore();
    await agentStore.providersHydrated;
    await settleSync();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(syncCalls(fetchMock)).toHaveLength(0);
    expect(localStorage.getItem("greywork.agent-providers")).not.toBeNull();
  });
});
