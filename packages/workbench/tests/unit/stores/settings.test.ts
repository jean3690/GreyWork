// 设置持久化验收：persist/loadPersisted 往返一致、推理等级非法值回退、损坏数据回退默认。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

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

describe("settings 持久化", () => {
  it("persist 后 loadPersisted 往返一致（含 reasoningEffort 与 cliIntegrations）", () => {
    const settings = useSettingsStore();
    const provider = settings.modelProviders[0];
    provider.reasoningEffort = "high";
    settings.cliIntegrations[0].reasoningEffort = "max";
    settings.locale = "en-US";
    settings.persist();

    setActivePinia(createPinia());
    const reloaded = useSettingsStore();
    expect(reloaded.modelProviders[0].reasoningEffort).toBe("high");
    expect(reloaded.cliIntegrations[0].reasoningEffort).toBe("max");
    expect(reloaded.locale).toBe("en-US");
  });

  it("loadPersisted 对非法 reasoningEffort 回退 auto", () => {
    storage.set(
      "greywork.settings",
      JSON.stringify({
        modelProviders: [{ id: "x", name: "X", model: "m", enabled: true, reasoningEffort: "ultra" }],
        cliIntegrations: [{ id: "cli", name: "CLI", reasoningEffort: "xhigh" }],
      }),
    );
    setActivePinia(createPinia());
    const settings = useSettingsStore();
    expect(settings.modelProviders[0].reasoningEffort).toBe("auto");
    expect(settings.cliIntegrations[0].reasoningEffort).toBe("auto");
  });

  it("损坏的本地设置回退默认", () => {
    storage.set("greywork.settings", "{broken");
    setActivePinia(createPinia());
    const settings = useSettingsStore();
    expect(settings.modelProviders.length).toBeGreaterThan(0);
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

  it("沙盒档位往返持久化，非法值回退默认 off", () => {
    const settings = useSettingsStore();
    settings.sandboxMode = "fs";
    settings.persist();
    setActivePinia(createPinia());
    expect(useSettingsStore().sandboxMode).toBe("fs");

    storage.set("greywork.settings", JSON.stringify({ sandboxMode: "yolo" }));
    setActivePinia(createPinia());
    expect(useSettingsStore().sandboxMode).toBe("off");
  });

  it("recommendedSandboxMode 按授权宽度给隔离强度", () => {
    expect(recommendedSandboxMode("read-only")).toBe("off");
    expect(recommendedSandboxMode("workspace")).toBe("fs");
    expect(recommendedSandboxMode("full")).toBe("full");
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
});
