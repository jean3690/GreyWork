// 设置持久化验收：persist/loadPersisted 往返一致、推理等级非法值回退、损坏数据回退默认。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { agentProviderLobeIcon } from "@greywork/shell";

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
};
vi.stubGlobal("localStorage", localStorageStub);
vi.stubGlobal("window", { localStorage: localStorageStub });

import { recommendedSandboxMode, useSettingsStore } from "@/stores/settings";

beforeEach(() => {
  storage.clear();
  setActivePinia(createPinia());
});

describe("ACP 品牌图标", () => {
  it("按 Lobe toc 选择可用变体，自定义图标优先", () => {
    expect(agentProviderLobeIcon({ id: "claude-code" })).toEqual({ slug: "claudecode", type: "color" });
    expect(agentProviderLobeIcon({ id: "opencode" })).toEqual({ slug: "opencode", type: "mono" });
    expect(agentProviderLobeIcon({ id: "opencode", icon: "magic" })).toBeNull();
    expect(agentProviderLobeIcon({ id: "custom-agent" })).toBeNull();
  });
});

describe("settings 持久化", () => {
  it("persist 后主题、模式与字号往返一致", () => {
    const settings = useSettingsStore();
    const provider = settings.modelProviders[0];
    provider.reasoningEffort = "high";
    settings.theme = "github";
    settings.colorMode = "light";
    settings.fontSize = "large";
    settings.locale = "en-US";
    settings.persist();

    setActivePinia(createPinia());
    const reloaded = useSettingsStore();
    expect(reloaded.modelProviders[0].reasoningEffort).toBe("high");
    expect(reloaded.theme).toBe("github");
    expect(reloaded.colorMode).toBe("light");
    expect(reloaded.fontSize).toBe("large");
    expect(reloaded.locale).toBe("en-US");
  });

  it("旧 theme 明暗字段迁移到 colorMode，主题回落 GreyWork", () => {
    storage.set("greywork.settings", JSON.stringify({ theme: "system" }));
    setActivePinia(createPinia());
    const settings = useSettingsStore();
    expect(settings.theme).toBe("greywork");
    expect(settings.colorMode).toBe("system");
  });

  it("loadPersisted 对非法 reasoningEffort 回退 auto", () => {
    storage.set(
      "greywork.settings",
      JSON.stringify({
        modelProviders: [{ id: "x", name: "X", model: "m", enabled: true, reasoningEffort: "ultra" }],
      }),
    );
    setActivePinia(createPinia());
    const settings = useSettingsStore();
    expect(settings.modelProviders[0].reasoningEffort).toBe("auto");
  });

  it("损坏的本地设置回退默认", () => {
    storage.set("greywork.settings", "{broken");
    setActivePinia(createPinia());
    const settings = useSettingsStore();
    expect(settings.modelProviders.length).toBeGreaterThan(0);
  });
});

describe("模型供应商自定义 headers", () => {
  it("headers 随 persist 往返保留，旧快照缺失时为 undefined", () => {
    const settings = useSettingsStore();
    const provider = settings.modelProviders[0];
    settings.upsertModelProvider({ ...provider, headers: { "X-Org": "acme", "X-Auth": "{{MY_TOKEN}}" } });
    settings.persist();

    setActivePinia(createPinia());
    const reloaded = useSettingsStore();
    expect(reloaded.modelProviders[0].headers).toEqual({ "X-Org": "acme", "X-Auth": "{{MY_TOKEN}}" });

    // 旧快照没有 headers 字段 → undefined（无附加头），不报错
    storage.set("greywork.settings", JSON.stringify({ modelProviders: [{ id: "x", name: "X", model: "m", enabled: true }] }));
    setActivePinia(createPinia());
    expect(useSettingsStore().modelProviders[0].headers).toBeUndefined();
  });

  it("脏 headers 被归一化：非 string 值与空 key 过滤，全空时整体 undefined", () => {
    storage.set(
      "greywork.settings",
      JSON.stringify({
        modelProviders: [{ id: "x", name: "X", model: "m", enabled: true, headers: { ok: "v", bad: 42, empty: "", " ": "v" } }],
      }),
    );
    setActivePinia(createPinia());
    expect(useSettingsStore().modelProviders[0].headers).toEqual({ ok: "v" });

    storage.set(
      "greywork.settings",
      JSON.stringify({
        modelProviders: [{ id: "x", name: "X", model: "m", enabled: true, headers: { bad: 42 } }],
      }),
    );
    setActivePinia(createPinia());
    expect(useSettingsStore().modelProviders[0].headers).toBeUndefined();
  });

  it("思考等级经 upsertModelProvider 即时更新并持久化", () => {
    const settings = useSettingsStore();
    const provider = settings.modelProviders[0];
    settings.upsertModelProvider({ ...provider, reasoningEffort: "medium" });
    expect(settings.modelProviders[0].reasoningEffort).toBe("medium");

    setActivePinia(createPinia());
    expect(useSettingsStore().modelProviders[0].reasoningEffort).toBe("medium");
  });
});

describe("权限档位与沙盒联动", () => {
  it("effectivePermissionTier 在临时降级期间为只读，关掉即回基线", () => {
    const settings = useSettingsStore();
    settings.permissionTier = "full";
    expect(settings.effectivePermissionTier).toBe("full");
    settings.tempReadOnly = true;
    expect(settings.effectivePermissionTier).toBe("read-only");
    settings.tempReadOnly = false;
    expect(settings.effectivePermissionTier).toBe("full");
  });

  it("临时降级刻意不持久化：重载回到基线档位", () => {
    const settings = useSettingsStore();
    settings.permissionTier = "full";
    settings.tempReadOnly = true;
    settings.persist();
    expect(storage.get("greywork.settings")).not.toContain("tempReadOnly");

    setActivePinia(createPinia());
    const reloaded = useSettingsStore();
    expect(reloaded.tempReadOnly).toBe(false);
    expect(reloaded.effectivePermissionTier).toBe("full");
  });

  it("沙盒档位往返持久化，旧快照缺失与非法值都迁移到 auto", () => {
    const settings = useSettingsStore();
    expect(settings.sandboxMode).toBe("auto");
    settings.sandboxMode = "fs";
    settings.persist();
    setActivePinia(createPinia());
    expect(useSettingsStore().sandboxMode).toBe("fs");

    storage.set("greywork.settings", JSON.stringify({ sandboxMode: "yolo" }));
    setActivePinia(createPinia());
    expect(useSettingsStore().sandboxMode).toBe("auto");

    storage.set("greywork.settings", JSON.stringify({ permissionTier: "workspace" }));
    setActivePinia(createPinia());
    expect(useSettingsStore().sandboxMode).toBe("auto");
  });

  it("recommendedSandboxMode 默认选择自动隔离，网络放行不被权限档位隐式开启", () => {
    expect(recommendedSandboxMode("read-only")).toBe("auto");
    expect(recommendedSandboxMode("workspace")).toBe("auto");
    expect(recommendedSandboxMode("full")).toBe("auto");
  });
});

describe("MCP 服务器声明", () => {
  it("内置 deepwiki 示例默认不启用，因此不会随会话下发", () => {
    const settings = useSettingsStore();
    const deepwiki = settings.mcpServers.find((server) => server.id === "deepwiki");
    expect(deepwiki).toMatchObject({ transport: "http", url: "https://mcp.deepwiki.com/mcp", enabled: false });
    expect(settings.enabledMcpServers).toEqual([]);
  });

  it("启用后进入下发清单，且剥掉 id/enabled 这类纯本地字段", () => {
    const settings = useSettingsStore();
    settings.setMcpServerEnabled("deepwiki", true);
    expect(settings.enabledMcpServers).toEqual([{ name: "deepwiki", transport: "http", url: "https://mcp.deepwiki.com/mcp" }]);
  });

  it("增删改往返持久化", () => {
    const settings = useSettingsStore();
    settings.upsertMcpServer({
      id: "notes",
      name: "notes",
      transport: "stdio",
      command: "/usr/bin/npx",
      args: ["notes-mcp"],
      enabled: true,
    });
    settings.setMcpServerEnabled("deepwiki", true);

    setActivePinia(createPinia());
    const reloaded = useSettingsStore();
    expect(reloaded.mcpServers.map((server) => server.id).sort()).toEqual(["deepwiki", "notes"]);
    expect(reloaded.enabledMcpServers).toHaveLength(2);

    reloaded.removeMcpServer("deepwiki");
    setActivePinia(createPinia());
    expect(useSettingsStore().mcpServers.map((server) => server.id)).toEqual(["notes"]);
  });

  it("upsert 按 id 覆盖而不是重复追加", () => {
    const settings = useSettingsStore();
    settings.upsertMcpServer({ id: "deepwiki", name: "deepwiki-2", transport: "sse", url: "https://x/sse", enabled: true });
    expect(settings.mcpServers).toHaveLength(1);
    expect(settings.mcpServers[0]).toMatchObject({ name: "deepwiki-2", transport: "sse" });
  });

  it("批量启停一次更新全部条目并持久化", () => {
    const settings = useSettingsStore();
    settings.upsertMcpServer({ id: "notes", name: "notes", transport: "stdio", command: "npx", enabled: false });

    settings.setAllMcpServersEnabled(true);
    expect(settings.mcpServers.every((server) => server.enabled)).toBe(true);

    setActivePinia(createPinia());
    expect(
      useSettingsStore()
        .enabledMcpServers.map((server) => server.name)
        .sort(),
    ).toEqual(["deepwiki", "notes"]);

    useSettingsStore().setAllMcpServersEnabled(false);
    setActivePinia(createPinia());
    expect(useSettingsStore().enabledMcpServers).toEqual([]);
  });

  it("快照里结构不合法的条目被丢弃，合法的保留", () => {
    storage.set(
      "greywork.settings",
      JSON.stringify({
        mcpServers: [
          { id: "ok", name: "ok", transport: "http", url: "https://x/mcp", enabled: true },
          { id: "bad-transport", name: "bad", transport: "pigeon", enabled: true },
          { name: "no-id", transport: "http", enabled: true },
          null,
        ],
      }),
    );
    const settings = useSettingsStore();
    expect(settings.mcpServers.map((server) => server.id)).toEqual(["ok"]);
  });

  it("编辑 = 按 id 覆盖且保留原 id，headers/env 随往返持久化", () => {
    const settings = useSettingsStore();
    settings.upsertMcpServer({
      id: "auth-srv",
      name: "auth-srv",
      transport: "http",
      url: "https://api.example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer tok" }],
      enabled: true,
    });
    // 编辑同一条（保留 id，改 url + 增补 header）
    settings.upsertMcpServer({
      id: "auth-srv",
      name: "auth-srv",
      transport: "http",
      url: "https://api.example.com/v2/mcp",
      headers: [
        { name: "Authorization", value: "Bearer tok2" },
        { name: "X-Trace", value: "1" },
      ],
      enabled: false,
    });
    expect(settings.mcpServers.filter((server) => server.id === "auth-srv")).toHaveLength(1);
    expect(settings.mcpServers.find((server) => server.id === "auth-srv")).toMatchObject({
      id: "auth-srv",
      url: "https://api.example.com/v2/mcp",
      enabled: false,
      headers: [
        { name: "Authorization", value: "Bearer tok2" },
        { name: "X-Trace", value: "1" },
      ],
    });

    setActivePinia(createPinia());
    const reloaded = useSettingsStore();
    expect(reloaded.mcpServers.find((server) => server.id === "auth-srv")).toMatchObject({
      id: "auth-srv",
      transport: "http",
      url: "https://api.example.com/v2/mcp",
      headers: [
        { name: "Authorization", value: "Bearer tok2" },
        { name: "X-Trace", value: "1" },
      ],
      enabled: false,
    });
    // 停用后不再进入下发清单
    expect(reloaded.enabledMcpServers).toEqual([]);
  });

  it("stdio 条目的 env 随往返持久化并原样下发", () => {
    const settings = useSettingsStore();
    settings.upsertMcpServer({
      id: "notes",
      name: "notes",
      transport: "stdio",
      command: "/usr/bin/npx",
      args: ["-y", "notes-mcp"],
      env: { NOTES_TOKEN: "secret" },
      enabled: true,
    });
    setActivePinia(createPinia());
    const reloaded = useSettingsStore();
    expect(reloaded.enabledMcpServers).toEqual([
      {
        name: "notes",
        transport: "stdio",
        command: "/usr/bin/npx",
        args: ["-y", "notes-mcp"],
        env: { NOTES_TOKEN: "secret" },
      },
    ]);
  });
});

describe("编排并发度 maxParallel", () => {
  it("写值后 persist 往返一致", () => {
    const settings = useSettingsStore();
    settings.maxParallel = 4;
    settings.persist();

    setActivePinia(createPinia());
    expect(useSettingsStore().maxParallel).toBe(4);
  });

  it("越界 / 非整数 / 非法类型静默回落默认 2", () => {
    const cases: unknown[] = [0, 99, -3, 1.5, "x", null, true];
    for (const value of cases) {
      storage.set("greywork.settings", JSON.stringify({ maxParallel: value }));
      setActivePinia(createPinia());
      expect(useSettingsStore().maxParallel).toBe(2);
    }
  });

  it("缺失字段回落默认 2", () => {
    storage.set("greywork.settings", JSON.stringify({}));
    setActivePinia(createPinia());
    expect(useSettingsStore().maxParallel).toBe(2);
  });
});
