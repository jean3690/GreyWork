// MCP 官方注册表：条目 → 登记草稿的传输归一 + 宿主搜索转发参数。
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as GreyWorkCore from "@greywork/core";
import { invoke } from "@tauri-apps/api/core";
import { registryEntryToDraft, searchMcpRegistry, type McpRegistryEntry } from "@/lib/mcp-registry";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@greywork/core", async (importOriginal) => {
  const actual = await importOriginal<typeof GreyWorkCore>();
  return { ...actual, isTauriRuntime: () => true };
});
const invokeMock = vi.mocked(invoke);

function entry(partial: Partial<McpRegistryEntry>): McpRegistryEntry {
  return {
    name: "ac.inference.sh/mcp",
    title: "inference.sh",
    description: "Run 150+ AI apps",
    remotes: [],
    packages: [],
    ...partial,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("registryEntryToDraft", () => {
  it("prefers streamable-http remote and maps it to ACP http", () => {
    const draft = registryEntryToDraft(
      entry({
        remotes: [{ transport: "streamable-http", url: "https://api.inference.sh/mcp" }],
        packages: [{ registry_type: "npm", identifier: "@x/y", env_names: ["API_TOKEN"] }],
      }),
    );
    expect(draft).toEqual({
      ok: true,
      transport: "http",
      url: "https://api.inference.sh/mcp",
      envNames: ["API_TOKEN"],
    });
  });

  it("falls back to sse remote when no http endpoint exists", () => {
    const draft = registryEntryToDraft(entry({ remotes: [{ transport: "sse", url: "https://x/sse" }] }));
    expect(draft).toMatchObject({ ok: true, transport: "sse", url: "https://x/sse" });
  });

  it("rejects stdio-only packages as unsupported (no host launch path)", () => {
    const draft = registryEntryToDraft(
      entry({
        remotes: [],
        packages: [{ registry_type: "npm", identifier: "@scope/server", version: "1.0.0", env_names: ["TOKEN"] }],
      }),
    );
    expect(draft).toEqual({
      ok: false,
      reason: "no-remote",
      transports: [],
    });
  });

  it("reports unsupported transports when remotes exist but none are registrable", () => {
    const draft = registryEntryToDraft(entry({ remotes: [{ transport: "websocket", url: "wss://x" }] }));
    expect(draft).toEqual({
      ok: false,
      reason: "unsupported-only",
      transports: ["websocket"],
    });
  });

  it("dedupes env names across packages", () => {
    const draft = registryEntryToDraft(
      entry({
        remotes: [{ transport: "streamable-http", url: "https://x/mcp" }],
        packages: [
          { registry_type: "npm", identifier: "a", env_names: ["KEY_A", "KEY_B"] },
          { registry_type: "npm", identifier: "b", env_names: ["KEY_A"] },
        ],
      }),
    );
    expect(draft.ok && draft.envNames).toEqual(["KEY_A", "KEY_B"]);
  });
});

describe("searchMcpRegistry", () => {
  it("forwards trimmed query and limit to the mcp_search host command", async () => {
    invokeMock.mockResolvedValue([]);
    await searchMcpRegistry("  notes  ", 25);
    expect(invokeMock).toHaveBeenCalledWith("mcp_search", { search: "notes", limit: 25 });

    await searchMcpRegistry("");
    expect(invokeMock).toHaveBeenCalledWith("mcp_search", { search: null, limit: 40 });
  });
});
